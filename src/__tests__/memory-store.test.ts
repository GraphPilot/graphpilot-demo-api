import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "../data/seed.ts";
import { MemoryStore } from "../store/memory-store.ts";
import { NotFoundError } from "../store/port.ts";

describe("MemoryStore", () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore();
    });

    it("starts from the seed", async () => {
        await expect(store.products()).resolves.toHaveLength(20);
        await expect(store.categories()).resolves.toHaveLength(4);
    });

    it("seeds the same catalogue twice", () => {
        expect(seed()).toEqual(seed());
    });

    it("filters products by category", async () => {
        const audio = await store.products("audio");

        expect(audio).toHaveLength(5);
        expect(audio.every((product) => product.categoryId === "audio")).toBe(true);
    });

    it("hands out copies, so a caller cannot mutate the catalogue", async () => {
        const [first] = await store.products();
        if (!first) {
            throw new Error("the seed is empty");
        }
        first.price = 1;

        const [again] = await store.products();
        expect(again?.price).not.toBe(1);
    });

    it("resolves and misses a product by id", async () => {
        await expect(store.product("p01")).resolves.toMatchObject({ id: "p01" });
        await expect(store.product("nope")).resolves.toBeNull();
    });

    it("serves a written price on the very next read", async () => {
        await store.setPrice("p01", 4242);

        await expect(store.product("p01")).resolves.toMatchObject({ price: 4242 });
    });

    it("refuses to price a product that does not exist", async () => {
        await expect(store.setPrice("nope", 1)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("adds a review and returns it on the next read", async () => {
        const review = await store.addReview({
            productId: "p02",
            author: "kay",
            body: "sturdy",
            rating: 5,
        });

        await expect(store.reviews("p02")).resolves.toContainEqual(review);
    });

    it("reserves stock and stamps the reservation", async () => {
        const before = await store.inventory("p01");
        const after = await store.reserveStock("p01", 3);

        expect(after.available).toBe(before.available - 3);
        expect(after.reservedAt).not.toBeNull();
    });

    it("refuses to reserve more than is available", async () => {
        await expect(store.reserveStock("p01", 1_000)).rejects.toThrow(/available/);
    });

    it("renames a category", async () => {
        await store.renameCategory("audio", "Sound");

        await expect(store.category("audio")).resolves.toMatchObject({ name: "Sound" });
    });

    it("searches case-insensitively by name", async () => {
        await expect(store.search("DESK")).resolves.not.toHaveLength(0);
        await expect(store.search("nothing-matches-this")).resolves.toHaveLength(0);
    });

    it("restores the seed on reset", async () => {
        await store.setPrice("p01", 1);
        await store.reserveStock("p01", 2);
        await store.reset();

        await expect(store.product("p01")).resolves.toEqual(seed().products[0]);
        await expect(store.inventory("p01")).resolves.toMatchObject({ reservedAt: null });
    });
});
