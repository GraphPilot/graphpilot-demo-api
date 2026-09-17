import { DurableObject } from "cloudflare:workers";
import { generateKeys } from "../auth/keys.ts";
import { seed } from "../data/seed.ts";
import {
    type ActivityEntry,
    type ActivityKind,
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
 * The catalogue on Workers: one Durable Object with a SQLite database, and a thin adapter that
 * satisfies `CatalogueStore` by talking to it.
 *
 * Why an object and not a module-scope Map: two requests to a Worker may land in two isolates, and
 * a write in one would be invisible to a read in the other. A demo whose whole subject is "the
 * cache was invalidated, so the next read is the new value" cannot afford an origin that sometimes
 * serves the old one. One named instance serializes every call, and SQLite writes land before the
 * call returns, so a read that follows a write sees the write.
 */

/** The row shapes, spelled the way SQLite hands them back: snake_case columns, and the index
 * signature `sql.exec<T>` asks of every row type. `toProduct` and friends translate. */
interface ProductRow {
    [column: string]: SqlStorageValue;
    id: string;
    name: string;
    price: number;
    rating: number;
    category_id: string;
    updated_at: string;
}

interface CategoryRow {
    [column: string]: SqlStorageValue;
    id: string;
    name: string;
}

interface ReviewRow {
    [column: string]: SqlStorageValue;
    id: string;
    product_id: string;
    author: string;
    body: string;
    rating: number;
    created_at: string;
}

interface InventoryRow {
    [column: string]: SqlStorageValue;
    product_id: string;
    available: number;
    reserved_at: string | null;
}

interface ActivityRow {
    [column: string]: SqlStorageValue;
    product_id: string;
    name: string;
    kind: string;
    at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    rating REAL NOT NULL,
    category_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    rating REAL NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
    product_id TEXT PRIMARY KEY,
    available INTEGER NOT NULL,
    reserved_at TEXT
);
`;

/** Where the generated key pair is kept. Not a catalogue table, so `reset` does not touch it: a
 * reader holding a token should not be logged out by restoring the products. */
const AUTH_KEY = "auth:private-jwk";

function toProduct(row: ProductRow): Product {
    return {
        id: row.id,
        name: row.name,
        price: row.price,
        rating: row.rating,
        categoryId: row.category_id,
        updatedAt: row.updated_at,
    };
}

function toReview(row: ReviewRow): Review {
    return {
        id: row.id,
        productId: row.product_id,
        author: row.author,
        body: row.body,
        rating: row.rating,
        createdAt: row.created_at,
    };
}

function toInventory(row: InventoryRow): Inventory {
    return {
        productId: row.product_id,
        available: row.available,
        reservedAt: row.reserved_at,
    };
}

/**
 * The catalogue itself. Every method is an RPC method: the adapter below calls them on a stub, and
 * the Workers runtime serializes arguments and return values for us.
 *
 * Rows come back in `rowid` order, which is insertion order, because `reset` rewrites the tables
 * from the seed in seed order. A demo whose list changes order between two otherwise identical
 * requests teaches the wrong lesson about caching.
 */
export class CatalogueObject extends DurableObject<unknown> {
    readonly #sql: SqlStorage;

    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        this.#sql = ctx.storage.sql;
        // Nothing else may run until the database exists and holds the seed.
        ctx.blockConcurrencyWhile(async () => {
            for (const statement of SCHEMA.split(";")) {
                if (statement.trim()) {
                    this.#sql.exec(statement);
                }
            }
            const count = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM products").one();
            if (count.n === 0) {
                this.#seed();
            }
        });
    }

    async products(filter?: CategoryId): Promise<Product[]> {
        const rows = filter
            ? this.#sql
                  .exec<ProductRow>(
                      "SELECT * FROM products WHERE category_id = ? ORDER BY rowid",
                      filter,
                  )
                  .toArray()
            : this.#sql.exec<ProductRow>("SELECT * FROM products ORDER BY rowid").toArray();
        return rows.map(toProduct);
    }

    async product(id: ProductId): Promise<Product | null> {
        const row = this.#product(id);
        return row ? toProduct(row) : null;
    }

    async setPrice(id: ProductId, price: Money): Promise<Product> {
        this.#requireProduct(id);
        const updatedAt = new Date().toISOString();
        this.#sql.exec(
            "UPDATE products SET price = ?, updated_at = ? WHERE id = ?",
            price,
            updatedAt,
            id,
        );
        return toProduct(this.#requireProduct(id));
    }

    async addReview(input: ReviewDraft): Promise<Review> {
        this.#requireProduct(input.productId);
        // The same id rule as the memory store, so a reader switching runtimes sees the same shape.
        const existing = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reviews").one().n;
        const review: Review = {
            id: `r-${existing + 1}-${input.productId}`,
            productId: input.productId,
            author: input.author,
            body: input.body,
            rating: input.rating,
            createdAt: new Date().toISOString(),
        };
        this.#sql.exec(
            "INSERT INTO reviews (id, product_id, author, body, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            review.id,
            review.productId,
            review.author,
            review.body,
            review.rating,
            review.createdAt,
        );
        return review;
    }

    async reserveStock(id: ProductId, count: number): Promise<Inventory> {
        this.#requireProduct(id);
        const current = await this.inventory(id);
        if (count > current.available) {
            throw new Error(`only ${current.available} of ${id} are available`);
        }
        const reservedAt = new Date().toISOString();
        this.#sql.exec(
            "UPDATE inventory SET available = available - ?, reserved_at = ? WHERE product_id = ?",
            count,
            reservedAt,
            id,
        );
        return this.inventory(id);
    }

    async reset(): Promise<void> {
        for (const table of ["products", "categories", "reviews", "inventory"]) {
            this.#sql.exec(`DELETE FROM ${table}`);
        }
        this.#seed();
    }

    async categories(): Promise<Category[]> {
        return this.#sql.exec<CategoryRow>("SELECT * FROM categories ORDER BY rowid").toArray();
    }

    async category(id: CategoryId): Promise<Category | null> {
        return (
            this.#sql.exec<CategoryRow>("SELECT * FROM categories WHERE id = ?", id).toArray()[0] ??
            null
        );
    }

    async search(term: string): Promise<Product[]> {
        const needle = term.trim().toLowerCase();
        if (needle === "") {
            return [];
        }
        // LIKE with the term escaped into the pattern, and the pattern passed as a parameter, so a
        // search term can never become SQL.
        const pattern = `%${needle.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
        return this.#sql
            .exec<ProductRow>(
                "SELECT * FROM products WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY rowid",
                pattern,
            )
            .toArray()
            .map(toProduct);
    }

    async reviews(productId: ProductId): Promise<Review[]> {
        return this.#sql
            .exec<ReviewRow>("SELECT * FROM reviews WHERE product_id = ? ORDER BY rowid", productId)
            .toArray()
            .map(toReview);
    }

    async inventory(productId: ProductId): Promise<Inventory> {
        const row = this.#sql
            .exec<InventoryRow>("SELECT * FROM inventory WHERE product_id = ?", productId)
            .toArray()[0];
        if (!row) {
            throw new NotFoundError("Inventory", productId);
        }
        return toInventory(row);
    }

    async renameCategory(id: CategoryId, name: string): Promise<Category> {
        if (!(await this.category(id))) {
            throw new NotFoundError("Category", id);
        }
        this.#sql.exec("UPDATE categories SET name = ? WHERE id = ?", name, id);
        return { id, name };
    }

    /**
     * The activity feed, read out of the two tables that already record when something changed. No
     * table of its own, so nothing can drift out of step with the catalogue it describes.
     *
     * The order is spelled out completely, ties included: a feed that comes back in two orders for
     * two identical requests would look exactly like a feed that was refreshed, and the stale
     * window test cannot afford that confusion.
     */
    async activity(limit: number): Promise<ActivityEntry[]> {
        const rows = this.#sql
            .exec<ActivityRow>(
                `SELECT p.id AS product_id, p.name AS name, 'PRICE_CHANGED' AS kind, p.updated_at AS at
                   FROM products p
                 UNION ALL
                 SELECT i.product_id AS product_id, p.name AS name, 'STOCK_RESERVED' AS kind, i.reserved_at AS at
                   FROM inventory i JOIN products p ON p.id = i.product_id
                  WHERE i.reserved_at IS NOT NULL
                 ORDER BY at DESC, product_id ASC, kind ASC
                 LIMIT ?`,
                Math.max(0, limit),
            )
            .toArray();
        return rows.map((row) => ({
            productId: row.product_id,
            name: row.name,
            kind: row.kind as ActivityKind,
            at: row.at,
        }));
    }

    /**
     * The private JWK every isolate of this Worker mints tokens with, generated once and kept.
     * Without it each isolate would mint tokens against its own key pair, and the key set an edge
     * fetched from one isolate would refuse the tokens another isolate handed out.
     */
    async authPrivateJwk(): Promise<string> {
        const stored = await this.ctx.storage.get<string>(AUTH_KEY);
        if (stored) {
            return stored;
        }
        const fresh = JSON.stringify((await generateKeys()).privateJwk);
        await this.ctx.storage.put(AUTH_KEY, fresh);
        return fresh;
    }

    #seed(): void {
        const catalogue = seed();
        for (const category of catalogue.categories) {
            this.#sql.exec(
                "INSERT INTO categories (id, name) VALUES (?, ?)",
                category.id,
                category.name,
            );
        }
        for (const product of catalogue.products) {
            this.#sql.exec(
                "INSERT INTO products (id, name, price, rating, category_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                product.id,
                product.name,
                product.price,
                product.rating,
                product.categoryId,
                product.updatedAt,
            );
        }
        for (const review of catalogue.reviews) {
            this.#sql.exec(
                "INSERT INTO reviews (id, product_id, author, body, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                review.id,
                review.productId,
                review.author,
                review.body,
                review.rating,
                review.createdAt,
            );
        }
        for (const entry of catalogue.inventory) {
            this.#sql.exec(
                "INSERT INTO inventory (product_id, available, reserved_at) VALUES (?, ?, ?)",
                entry.productId,
                entry.available,
                entry.reservedAt,
            );
        }
    }

    #product(id: ProductId): ProductRow | undefined {
        return this.#sql.exec<ProductRow>("SELECT * FROM products WHERE id = ?", id).toArray()[0];
    }

    #requireProduct(id: ProductId): ProductRow {
        const row = this.#product(id);
        if (!row) {
            throw new NotFoundError("Product", id);
        }
        return row;
    }
}

/** The name of the one instance that holds the catalogue. Every request addresses it, which is
 * what makes a write visible to the read after it. */
export const CATALOGUE_NAME = "catalogue";

/**
 * The port, over a Durable Object. It forwards and translates, and holds no state of its own: the
 * state is the point of the object it talks to.
 *
 * The stub is resolved per call and never kept. A stub is an I/O object owned by the request that
 * created it, so one held in a field of a store that outlives the request is refused on the next
 * one with "Cannot perform I/O on behalf of a different request". Holding only the binding lets the
 * worker cache the executable schema, which is the expensive part, without caching anything the
 * runtime scopes to a request.
 */
export class DurableObjectStore implements CatalogueStore {
    readonly #namespace: DurableObjectNamespace<CatalogueObject>;
    readonly #name: string;

    constructor(namespace: DurableObjectNamespace<CatalogueObject>, name = CATALOGUE_NAME) {
        this.#namespace = namespace;
        this.#name = name;
    }

    get #stub(): DurableObjectStub<CatalogueObject> {
        return this.#namespace.get(this.#namespace.idFromName(this.#name));
    }

    products(filter?: CategoryId): Promise<Product[]> {
        return call(() => this.#stub.products(filter));
    }

    product(id: ProductId): Promise<Product | null> {
        return call(() => this.#stub.product(id));
    }

    setPrice(id: ProductId, price: Money): Promise<Product> {
        return call(() => this.#stub.setPrice(id, price));
    }

    addReview(input: ReviewDraft): Promise<Review> {
        // Rebuilt field by field, because what arrives here is a GraphQL input value: an object with
        // a null prototype, which structured clone refuses with "does not support serialization".
        // Every argument that crosses to a Durable Object has to be a plain value, and this is the
        // only argument in the port that is not already one.
        return call(() =>
            this.#stub.addReview({
                productId: input.productId,
                author: input.author,
                body: input.body,
                rating: input.rating,
            }),
        );
    }

    reserveStock(id: ProductId, count: number): Promise<Inventory> {
        return call(() => this.#stub.reserveStock(id, count));
    }

    reset(): Promise<void> {
        return call(() => this.#stub.reset());
    }

    categories(): Promise<Category[]> {
        return call(() => this.#stub.categories());
    }

    category(id: CategoryId): Promise<Category | null> {
        return call(() => this.#stub.category(id));
    }

    search(term: string): Promise<Product[]> {
        return call(() => this.#stub.search(term));
    }

    reviews(productId: ProductId): Promise<Review[]> {
        return call(() => this.#stub.reviews(productId));
    }

    inventory(productId: ProductId): Promise<Inventory> {
        return call(() => this.#stub.inventory(productId));
    }

    renameCategory(id: CategoryId, name: string): Promise<Category> {
        return call(() => this.#stub.renameCategory(id, name));
    }

    activity(limit: number): Promise<ActivityEntry[]> {
        return call(() => this.#stub.activity(limit));
    }

    /** Not part of the port: the token endpoint's key, kept next to the catalogue because a
     * Durable Object is the only thing on Workers that every isolate agrees about. */
    authPrivateJwk(): Promise<string> {
        return call(() => this.#stub.authPrivateJwk());
    }
}

/**
 * An error thrown inside a Durable Object reaches the caller as a plain `Error`: the class is lost
 * across the RPC boundary, only the name and the message survive. Rebuilding it here keeps the
 * port's contract true on both runtimes, so a caller matching on `NotFoundError` keeps matching.
 */
async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof Error && error.name === "NotFoundError") {
            const rebuilt = new NotFoundError("", "");
            rebuilt.message = error.message;
            throw rebuilt;
        }
        throw error;
    }
}
