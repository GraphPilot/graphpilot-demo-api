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

export type ActivityKind = "PRICE_CHANGED" | "STOCK_RESERVED";

/** One line of the activity feed, derived from the catalogue rather than recorded beside it: a
 * price change moves a product's `updatedAt`, a reservation stamps its inventory. */
export interface ActivityEntry {
    productId: ProductId;
    name: string;
    kind: ActivityKind;
    /** ISO 8601. */
    at: string;
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

    /** The newest `limit` entries, newest first, ties broken by product id so two identical
     * requests never come back in two orders. A feed that reorders itself would be indistinguishable
     * from a feed that was refreshed, which is exactly the distinction the stale window test makes. */
    activity(limit: number): Promise<ActivityEntry[]>;

    /**
     * Count one attempt against a requested transient failure, and say whether this attempt fails.
     *
     * The counter is why this is in the store rather than in the worker. An origin retry happens
     * inside one client request: the edge asks, is refused, waits, and asks again with byte-identical
     * bytes. The two attempts carry nothing that tells them apart, so the only way the origin can
     * fail the first and answer the second is to remember that it already refused one. Module-scope
     * state cannot promise that, because the second attempt may land in another isolate, which is
     * the same reason the catalogue lives here.
     *
     * Returns `true` while fewer than `times` attempts have been refused for this nonce, counting
     * this one, and `false` from then on. A nonce nobody has used starts at zero, so the first
     * `times` attempts fail and everything after succeeds.
     *
     * Rows are pruned by age rather than on success: a caller that asks for two failures and then
     * gives up would otherwise leave its row behind forever, and this runs on a public demo.
     */
    consumeFault(nonce: string, times: number): Promise<boolean>;
}

/**
 * How long a fault counter is remembered.
 *
 * Long enough to outlast any retry sequence the platform permits (a request may spend at most 120
 * seconds at the edge, backoff included) and short enough that the table stays small without a
 * scheduled job. A nonce older than this is indistinguishable from one that was never used.
 */
export const FAULT_TTL_MS = 10 * 60 * 1000;

/** The longest nonce accepted, so a public endpoint cannot be used to store arbitrary text. */
export const FAULT_NONCE_MAX_LENGTH = 128;

/** The most attempts one nonce may be asked to fail, so a caller cannot ask the origin to stay down. */
export const FAULT_TIMES_MAX = 5;

/** Thrown when a mutation or a lookup names something the catalogue does not hold. */
export class NotFoundError extends Error {
    constructor(what: string, id: string) {
        super(`${what} ${id} does not exist`);
        this.name = "NotFoundError";
    }
}
