/**
 * The storage port. Everything above it is runtime-agnostic: the resolvers know this interface and
 * nothing else, so the same schema runs over a Map on Node and over a Durable Object on Workers.
 *
 * The port is part of the lesson. "The cache is invalidated on write" is only honest if the origin
 * serves the new value on the very next read, which module-scope state on a Workers isolate cannot
 * promise.
 */

export type ProductId = string;
export type CategoryId = string;
export type ReviewId = string;

/** Price in minor units, so 1999 is 19.99. Integer arithmetic, no rounding surprises. */
export type Money = number;

export interface Product {
    id: ProductId;
    name: string;
    price: Money;
    rating: number;
    categoryId: CategoryId;
    /** ISO 8601. */
    updatedAt: string;
}

export interface Category {
    id: CategoryId;
    name: string;
}

export interface Review {
    id: ReviewId;
    productId: ProductId;
    author: string;
    body: string;
    rating: number;
    /** ISO 8601. */
    createdAt: string;
}

export interface Inventory {
    productId: ProductId;
    available: number;
    /** ISO 8601, null until something is reserved. */
    reservedAt: string | null;
}

export interface ReviewDraft {
    productId: ProductId;
    author: string;
    body: string;
    rating: number;
}

/** The whole catalogue in one value, which is what a seed produces and `reset` restores. */
export interface Catalogue {
    products: Product[];
    categories: Category[];
    reviews: Review[];
    inventory: Inventory[];
}

export interface CatalogueStore {
    products(filter?: CategoryId): Promise<Product[]>;
    product(id: ProductId): Promise<Product | null>;
    setPrice(id: ProductId, price: Money): Promise<Product>;
    addReview(input: ReviewDraft): Promise<Review>;
    reserveStock(id: ProductId, count: number): Promise<Inventory>;
    reset(): Promise<void>;

    // The reads and the one write the schema needs beyond the six above. They are here rather than
    // in the resolvers because an adapter over a Durable Object cannot hand out the catalogue and
    // let the caller filter it.
    categories(): Promise<Category[]>;
    category(id: CategoryId): Promise<Category | null>;
    search(term: string): Promise<Product[]>;
    reviews(productId: ProductId): Promise<Review[]>;
    inventory(productId: ProductId): Promise<Inventory>;
    renameCategory(id: CategoryId, name: string): Promise<Category>;
}

/** Thrown when a mutation or a lookup names something the catalogue does not hold. */
export class NotFoundError extends Error {
    constructor(what: string, id: string) {
        super(`${what} ${id} does not exist`);
        this.name = "NotFoundError";
    }
}
