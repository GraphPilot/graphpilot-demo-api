import type {
    ActivityEntry,
    CatalogueStore,
    Category,
    CategoryId,
    Inventory,
    Money,
    Product,
    ProductId,
    Review,
    ReviewDraft,
} from "./port.ts";

/**
 * One request's view of a store: every read asked once, every write passed straight through.
 *
 * Why it exists. On Workers each store call is an RPC to the one Durable Object, and that object
 * lives in one place. A document that fans out, `product { category { products { category { ... } } } }`,
 * asks the same few questions hundreds of times: ten levels deep it made 313 calls for three
 * distinct ones. From an isolate on the other side of an ocean each call is a round trip across it,
 * and the system tests watched that document take about 45 seconds from a US runner until the edge
 * gave up with a 502. Here the repeats are answered from the first call's promise, so the same
 * document costs three round trips wherever it runs.
 *
 * What keeps it honest, because "the origin serves the newest value on the very next read" is the
 * claim the whole demo rests on:
 *
 * - **One per request, never shared.** A memo that outlived its request would hand the next
 *   request an answer from before somebody else's write. `forRequest` below keys it on the
 *   request's GraphQL context, which Yoga builds fresh for every request.
 * - **Any write empties it, before and after.** A mutation's own selection, and every mutation
 *   after it in the same operation, reads what the write left behind. Emptied before as well, so a
 *   read that was still in flight when the write started cannot be reused once it ends.
 * - **A failed read is not kept.** The callers that were already waiting on it share the failure,
 *   which is what they would have seen anyway; a later caller asks the store again.
 *
 * The promise is stored, not the value, so calls made in the same tick share one round trip
 * instead of racing each other to fill the memo. Callers share the returned objects too; no
 * resolver mutates what it reads, and none may start.
 */
export class RequestScopedStore implements CatalogueStore {
    readonly #inner: CatalogueStore;
    readonly #memo = new Map<string, Promise<unknown>>();

    constructor(inner: CatalogueStore) {
        this.#inner = inner;
    }

    products(filter?: CategoryId): Promise<Product[]> {
        return this.#read(["products", filter ?? null], () => this.#inner.products(filter));
    }

    product(id: ProductId): Promise<Product | null> {
        return this.#read(["product", id], () => this.#inner.product(id));
    }

    categories(): Promise<Category[]> {
        return this.#read(["categories"], () => this.#inner.categories());
    }

    category(id: CategoryId): Promise<Category | null> {
        return this.#read(["category", id], () => this.#inner.category(id));
    }

    search(term: string): Promise<Product[]> {
        return this.#read(["search", term], () => this.#inner.search(term));
    }

    reviews(productId: ProductId): Promise<Review[]> {
        return this.#read(["reviews", productId], () => this.#inner.reviews(productId));
    }

    inventory(productId: ProductId): Promise<Inventory> {
        return this.#read(["inventory", productId], () => this.#inner.inventory(productId));
    }

    activity(limit: number): Promise<ActivityEntry[]> {
        return this.#read(["activity", limit], () => this.#inner.activity(limit));
    }

    setPrice(id: ProductId, price: Money): Promise<Product> {
        return this.#write(() => this.#inner.setPrice(id, price));
    }

    addReview(input: ReviewDraft): Promise<Review> {
        return this.#write(() => this.#inner.addReview(input));
    }

    reserveStock(id: ProductId, count: number): Promise<Inventory> {
        return this.#write(() => this.#inner.reserveStock(id, count));
    }

    renameCategory(id: CategoryId, name: string): Promise<Category> {
        return this.#write(() => this.#inner.renameCategory(id, name));
    }

    reset(): Promise<void> {
        return this.#write(() => this.#inner.reset());
    }

    /** A write in all but name: it counts an attempt, and its answer changes with every call. */
    consumeFault(nonce: string, times: number): Promise<boolean> {
        return this.#write(() => this.#inner.consumeFault(nonce, times));
    }

    #read<T>(key: unknown[], load: () => Promise<T>): Promise<T> {
        // JSON rather than a join, so no argument value can make two different calls collide.
        const id = JSON.stringify(key);
        const cached = this.#memo.get(id);
        if (cached) {
            return cached as Promise<T>;
        }
        const loading = load();
        this.#memo.set(id, loading);
        loading.catch(() => {
            // Only if it is still this call's entry: a write may have emptied the memo and a newer
            // read taken the slot since.
            if (this.#memo.get(id) === loading) {
                this.#memo.delete(id);
            }
        });
        return loading;
    }

    async #write<T>(operation: () => Promise<T>): Promise<T> {
        this.#memo.clear();
        try {
            return await operation();
        } finally {
            this.#memo.clear();
        }
    }
}

/**
 * The store a resolver uses for the request it is resolving.
 *
 * Keyed on the context object rather than carried in it, so the store stays bound at schema
 * construction and a resolver cannot be handed a different one mid-request; only the memo is per
 * request. The WeakMap lets a finished request's memo go with its context. A caller that passes no
 * context object (a bare `graphql()` call) gets the store itself, unmemoized.
 */
export function forRequest(store: CatalogueStore): (context: unknown) => CatalogueStore {
    const scoped = new WeakMap<object, RequestScopedStore>();
    return (context) => {
        if (typeof context !== "object" || context === null) {
            return store;
        }
        let found = scoped.get(context);
        if (!found) {
            found = new RequestScopedStore(store);
            scoped.set(context, found);
        }
        return found;
    };
}
