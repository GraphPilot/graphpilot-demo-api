import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seed } from "../../data/seed.ts";
import { DurableObjectStore } from "../../store/durable-object-store.ts";
import { NotFoundError } from "../../store/port.ts";

/**
 * The store adapter, against a real Durable Object inside workerd. The claim under test is the one
 * the whole demo rests on: a write is visible to the very next read. A module-scope Map on Workers
 * cannot promise that, which is why this adapter exists.
 */

/** A fresh instance per test, so one test's writes never explain another test's reads. */
function storeNamed(name: string): DurableObjectStore {
    return new DurableObjectStore(env.CATALOGUE, name);
}

describe("DurableObjectStore", () => {
    it("serves the seed before anything has been written", async () => {
        const store = storeNamed("seeded");
        const products = await store.products();
        const expected = seed();

        expect(products).toHaveLength(expected.products.length);
        expect(products[0]).toEqual(expected.products[0]);
        expect(await store.categories()).toEqual(expected.categories);
    });

    it("returns the written price on the very next read", async () => {
        const store = storeNamed("write-then-read");
        const written = await store.setPrice("p01", 4242);
        expect(written.price).toBe(4242);

        const read = await store.product("p01");
        expect(read?.price).toBe(4242);
        // The write also moves the timestamp, which is what a cache key derived from it reacts to.
        expect(read?.updatedAt).not.toBe(seed().products[0]?.updatedAt);
    });

    it("keeps a review and hands it back with the product", async () => {
        const store = storeNamed("reviews");
        const review = await store.addReview({
            productId: "p02",
            author: "a-reader",
            body: "unique body",
            rating: 5,
        });

        const stored = await store.reviews("p02");
        expect(stored.map((entry) => entry.id)).toContain(review.id);
        expect(stored.find((entry) => entry.id === review.id)?.body).toBe("unique body");
    });

    it("reserves stock and subtracts it from what is available", async () => {
        const store = storeNamed("stock");
        const before = await store.inventory("p03");
        const after = await store.reserveStock("p03", 2);

        expect(after.available).toBe(before.available - 2);
        expect(after.reservedAt).not.toBeNull();
        expect((await store.inventory("p03")).available).toBe(before.available - 2);
    });

    it("renames a category and finds it again under the new name", async () => {
        const store = storeNamed("rename");
        await store.renameCategory("audio", "Sound");
        expect((await store.category("audio"))?.name).toBe("Sound");
    });

    it("restores the seed on reset", async () => {
        const store = storeNamed("reset");
        await store.setPrice("p01", 999999);
        await store.addReview({ productId: "p01", author: "a", body: "b", rating: 1 });
        await store.renameCategory("audio", "Gone");

        await store.reset();

        const expected = seed();
        expect((await store.product("p01"))?.price).toBe(expected.products[0]?.price);
        expect((await store.product("p01"))?.updatedAt).toBe(expected.products[0]?.updatedAt);
        expect(await store.reviews("p01")).toEqual(
            expected.reviews.filter((review) => review.productId === "p01"),
        );
        expect((await store.category("audio"))?.name).toBe("Audio");
    });

    it("filters products by category and searches by name", async () => {
        const store = storeNamed("reads");
        const audio = await store.products("audio");
        expect(audio).toHaveLength(5);
        expect(audio.every((product) => product.categoryId === "audio")).toBe(true);

        const found = await store.search("monitor");
        expect(found.map((product) => product.name)).toContain("Studio Monitor");
        expect(await store.search("   ")).toEqual([]);
    });

    // The feed behind the short stale window. The two runtimes have to agree about it, because a
    // system test measures the deployed one and the unit tests measure this one.
    it("feeds the newest changes first, and a reservation lands at the top", async () => {
        const store = storeNamed("activity");
        const seeded = await store.activity(5);
        expect(seeded).toHaveLength(5);
        expect(seeded[0]).toMatchObject({ productId: "p20", kind: "PRICE_CHANGED" });

        await store.reserveStock("p07", 1);
        const after = await store.activity(3);
        expect(after[0]).toMatchObject({ productId: "p07", kind: "STOCK_RESERVED" });
    });

    it("answers the same feed twice, so a repeated request is a repeated answer", async () => {
        const store = storeNamed("activity-stable");
        expect(await store.activity(10)).toEqual(await store.activity(10));
    });

    it("answers null for an unknown product and refuses an unknown write", async () => {
        const store = storeNamed("missing");
        expect(await store.product("nope")).toBeNull();
        expect(await store.category("nope")).toBeNull();
        // The error crosses the RPC boundary as a plain Error, so the adapter rebuilds it. Without
        // that, a caller matching on the port's own error type would silently stop matching.
        await expect(store.setPrice("nope", 1)).rejects.toBeInstanceOf(NotFoundError);
        await expect(store.inventory("nope")).rejects.toBeInstanceOf(NotFoundError);
    });
});
