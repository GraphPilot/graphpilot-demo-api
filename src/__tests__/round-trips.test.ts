import { type ExecutionResult, graphql } from "graphql";
import { describe, expect, it } from "vitest";
import type { DemoContext } from "../resolvers/index.ts";
import { createSchema } from "../schema.ts";
import { MemoryStore } from "../store/memory-store.ts";
import type { CatalogueStore } from "../store/port.ts";
import { RequestScopedStore } from "../store/request-scoped-store.ts";

/**
 * How many times one GraphQL request reaches the store.
 *
 * On Workers every store call is an RPC to the one Durable Object, which lives in one place. From
 * an isolate on another continent each of those is a transatlantic round trip, so a document whose
 * answer fans out pays for its fan-out in network time. The system tests' ten-level document did
 * exactly that from a US runner: 313 round trips, about 45 seconds, and a 502 from the edge.
 */

/** The document the system tests send. Five products per category, so it answers 5^4 ids. */
const DEEP = `query($id: ID!) { product(id: $id) { category { products { category { products {
    category { products { category { products { id } } } } } } } } } }`;

/** A store that forwards to a real one and counts every call, by method name. */
function counting(inner: CatalogueStore): { store: CatalogueStore; calls: string[] } {
    const calls: string[] = [];
    const store = new Proxy(inner, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") {
                return value;
            }
            return (...args: unknown[]) => {
                calls.push(String(property));
                return value.apply(target, args);
            };
        },
    });
    return { store, calls };
}

function run(
    store: CatalogueStore,
    source: string,
    variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> {
    return graphql({
        schema: createSchema(store),
        source,
        contextValue: { claims: null } satisfies DemoContext,
        ...(variableValues ? { variableValues } : {}),
    });
}

/** Every leaf id of the deep answer, in order. */
function leafIds(result: ExecutionResult): string[] {
    type Node = { id?: string; category?: { products: Node[] } };
    const walk = (node: Node): string[] =>
        node.category ? node.category.products.flatMap(walk) : node.id ? [node.id] : [];
    return walk(result.data?.product as Node);
}

describe("store round trips per request", () => {
    it("answers the ten-level document with three store calls", async () => {
        const { store, calls } = counting(new MemoryStore());

        const result = await run(store, DEEP, { id: "p01" });

        expect(result.errors).toBeUndefined();
        expect(leafIds(result)).toHaveLength(625);
        // product(p01), category(audio), products(audio). Everything below repeats those keys.
        expect(calls.sort()).toEqual(["category", "product", "products"]);
    });

    it("answers exactly what an unmemoized store answers", async () => {
        const direct = await graphql({
            schema: createSchema(new MemoryStore()),
            source: DEEP,
            variableValues: { id: "p01" },
            // No context object: nothing to scope a memo to, so every call goes straight through.
        });
        const memoized = await run(new MemoryStore(), DEEP, { id: "p01" });

        expect(memoized).toEqual(direct);
    });

    it("never shares a memo between two requests", async () => {
        const { store, calls } = counting(new MemoryStore());

        await run(store, '{ product(id: "p01") { price } }');
        await store.setPrice("p01", 4242);
        const read = await run(store, '{ product(id: "p01") { price } }');

        expect(read.data).toEqual({ product: { price: 4242 } });
        expect(calls.filter((name) => name === "product")).toHaveLength(2);
    });

    it("reads a write made earlier in the same request", async () => {
        const result = await run(
            new MemoryStore(),
            `mutation {
                before: setPrice(id: "p02", price: 1) { category { name products { id price } } }
                rename: renameCategory(id: "audio", name: "Sound") { name }
                after: setPrice(id: "p01", price: 4242) { category { name products { id price } } }
            }`,
        );

        expect(result.errors).toBeUndefined();
        type Answer = { category: { name: string; products: { id: string; price: number }[] } };
        const before = result.data?.before as Answer;
        const after = result.data?.after as Answer;
        // The first field put category(audio) and products(audio) in the memo. Both writes after
        // it must be visible to the reads that follow them.
        expect(before.category.name).toBe("Audio");
        expect(after.category.name).toBe("Sound");
        expect(after.category.products.find((p) => p.id === "p01")?.price).toBe(4242);
        expect(after.category.products.find((p) => p.id === "p02")?.price).toBe(1);
    });

    it("fetches a read repeated across two root fields once", async () => {
        const { store, calls } = counting(new MemoryStore());

        const result = await run(
            store,
            `{ a: product(id: "p01") { inventory { available } }
               b: product(id: "p01") { inventory { available } } }`,
        );

        expect(result.errors).toBeUndefined();
        expect(calls.filter((name) => name === "inventory")).toHaveLength(1);
    });
});

describe("RequestScopedStore", () => {
    it("shares one call between reads made in the same tick", async () => {
        const { store, calls } = counting(new MemoryStore());
        const scoped = new RequestScopedStore(store);

        const [a, b] = await Promise.all([scoped.products("audio"), scoped.products("audio")]);

        expect(a).toBe(b);
        expect(calls).toEqual(["products"]);
    });

    it("keys on every argument, so two filters are two calls", async () => {
        const { store, calls } = counting(new MemoryStore());
        const scoped = new RequestScopedStore(store);

        await scoped.products();
        await scoped.products("audio");
        await scoped.products("desks");
        await scoped.products("audio");

        expect(calls).toEqual(["products", "products", "products"]);
    });

    it("asks again after every kind of write", async () => {
        const writes: ((scoped: RequestScopedStore) => Promise<unknown>)[] = [
            (scoped) => scoped.setPrice("p01", 1),
            (scoped) => scoped.addReview({ productId: "p01", author: "a", body: "b", rating: 5 }),
            (scoped) => scoped.reserveStock("p01", 1),
            (scoped) => scoped.renameCategory("audio", "Sound"),
            (scoped) => scoped.reset(),
            (scoped) => scoped.consumeFault("nonce", 1),
        ];
        for (const write of writes) {
            const { store, calls } = counting(new MemoryStore());
            const scoped = new RequestScopedStore(store);

            await scoped.product("p01");
            await write(scoped);
            await scoped.product("p01");

            expect(calls.filter((name) => name === "product")).toHaveLength(2);
        }
    });

    it("does not keep a read that was in flight while a write ran", async () => {
        const inner = new MemoryStore();
        const scoped = new RequestScopedStore(inner);

        const stale = scoped.product("p01");
        await scoped.setPrice("p01", 4242);
        await stale;

        expect((await scoped.product("p01"))?.price).toBe(4242);
    });

    it("does not keep a failed read, so a later call asks again", async () => {
        const { store, calls } = counting(new MemoryStore());
        const scoped = new RequestScopedStore(store);

        await expect(scoped.inventory("nope")).rejects.toThrow("does not exist");
        await expect(scoped.inventory("nope")).rejects.toThrow("does not exist");

        expect(calls).toEqual(["inventory", "inventory"]);
    });
});
