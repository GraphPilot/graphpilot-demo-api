import { seed } from "../data/seed.ts";
import {
    type ActivityEntry,
    type Catalogue,
    type CatalogueStore,
    type Category,
    type CategoryId,
    type Inventory,
    type Money,
    NotFoundError,
    type Product,
    type ProductId,
    type Review,
    type ReviewDraft,
} from "./port.ts";

/**
 * The adapter a reader meets first: the whole catalogue in one object, replaced wholesale on
 * `reset`. Good for Node, Docker, local runs and the unit tests, and useless on Workers, where two
 * requests may land in different isolates and a write would be invisible to the next read.
 *
 * Every read returns a copy. A caller that mutates what it got would otherwise change the
 * catalogue without going through a write, which is exactly the confusion a cache demo cannot
 * afford.
 */
export class MemoryStore implements CatalogueStore {
    #catalogue: Catalogue;
    readonly #now: () => Date;

    constructor(now: () => Date = () => new Date()) {
        this.#catalogue = seed();
        this.#now = now;
    }

    async products(filter?: CategoryId): Promise<Product[]> {
        const all = this.#catalogue.products;
        return (filter ? all.filter((product) => product.categoryId === filter) : all).map(copy);
    }

    async product(id: ProductId): Promise<Product | null> {
        const found = this.#find(id);
        return found ? copy(found) : null;
    }

    async setPrice(id: ProductId, price: Money): Promise<Product> {
        const product = this.#require(id);
        product.price = price;
        product.updatedAt = this.#now().toISOString();
        return copy(product);
    }

    async addReview(input: ReviewDraft): Promise<Review> {
        this.#require(input.productId);
        const review: Review = {
            id: `r-${this.#catalogue.reviews.length + 1}-${input.productId}`,
            productId: input.productId,
            author: input.author,
            body: input.body,
            rating: input.rating,
            createdAt: this.#now().toISOString(),
        };
        this.#catalogue.reviews.push(review);
        return copy(review);
    }

    async reserveStock(id: ProductId, count: number): Promise<Inventory> {
        this.#require(id);
        const inventory = this.#catalogue.inventory.find((entry) => entry.productId === id);
        if (!inventory) {
            throw new NotFoundError("Inventory", id);
        }
        if (count > inventory.available) {
            throw new Error(`only ${inventory.available} of ${id} are available`);
        }
        inventory.available -= count;
        inventory.reservedAt = this.#now().toISOString();
        return copy(inventory);
    }

    async reset(): Promise<void> {
        this.#catalogue = seed();
    }

    async categories(): Promise<Category[]> {
        return this.#catalogue.categories.map(copy);
    }

    async category(id: CategoryId): Promise<Category | null> {
        const found = this.#catalogue.categories.find((category) => category.id === id);
        return found ? copy(found) : null;
    }

    async search(term: string): Promise<Product[]> {
        const needle = term.trim().toLowerCase();
        if (needle === "") {
            return [];
        }
        return this.#catalogue.products
            .filter((product) => product.name.toLowerCase().includes(needle))
            .map(copy);
    }

    async reviews(productId: ProductId): Promise<Review[]> {
        return this.#catalogue.reviews.filter((review) => review.productId === productId).map(copy);
    }

    async inventory(productId: ProductId): Promise<Inventory> {
        const found = this.#catalogue.inventory.find((entry) => entry.productId === productId);
        if (!found) {
            throw new NotFoundError("Inventory", productId);
        }
        return copy(found);
    }

    async renameCategory(id: CategoryId, name: string): Promise<Category> {
        const category = this.#catalogue.categories.find((entry) => entry.id === id);
        if (!category) {
            throw new NotFoundError("Category", id);
        }
        category.name = name;
        return copy(category);
    }

    async activity(limit: number): Promise<ActivityEntry[]> {
        const byProduct = new Map(this.#catalogue.products.map((product) => [product.id, product]));
        const entries: ActivityEntry[] = [];

        for (const product of this.#catalogue.products) {
            entries.push({
                productId: product.id,
                name: product.name,
                kind: "PRICE_CHANGED",
                at: product.updatedAt,
            });
        }
        for (const entry of this.#catalogue.inventory) {
            const product = byProduct.get(entry.productId);
            if (entry.reservedAt && product) {
                entries.push({
                    productId: product.id,
                    name: product.name,
                    kind: "STOCK_RESERVED",
                    at: entry.reservedAt,
                });
            }
        }

        return entries.sort(newestFirst).slice(0, Math.max(0, limit));
    }

    #find(id: ProductId): Product | undefined {
        return this.#catalogue.products.find((product) => product.id === id);
    }

    #require(id: ProductId): Product {
        const product = this.#find(id);
        if (!product) {
            throw new NotFoundError("Product", id);
        }
        return product;
    }
}

function copy<T>(value: T): T {
    return { ...value };
}

/** Newest first, and two entries stamped in the same second are ordered by product id and then by
 * kind, so the answer is a function of the catalogue and of nothing else. */
function newestFirst(left: ActivityEntry, right: ActivityEntry): number {
    if (left.at !== right.at) {
        return left.at < right.at ? 1 : -1;
    }
    if (left.productId !== right.productId) {
        return left.productId < right.productId ? -1 : 1;
    }
    return left.kind < right.kind ? -1 : 1;
}
