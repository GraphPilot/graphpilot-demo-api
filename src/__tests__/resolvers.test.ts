import { type ExecutionResult, type GraphQLSchema, graphql } from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import type { DemoContext } from "../resolvers/index.ts";
import { createSchema } from "../schema.ts";
import { MemoryStore } from "../store/memory-store.ts";

let store: MemoryStore;
let schema: GraphQLSchema;

function run(
    source: string,
    variableValues?: Record<string, unknown>,
    claims: DemoContext["claims"] = null,
): Promise<ExecutionResult> {
    return graphql({
        schema,
        source,
        contextValue: { claims } satisfies DemoContext,
        ...(variableValues ? { variableValues } : {}),
    });
}

/** Every test starts from the seed, so nothing accumulates across cases. */
beforeEach(() => {
    store = new MemoryStore();
    schema = createSchema(store);
});

describe("queries", () => {
    it("returns the seeded 20 products", async () => {
        const result = await run("{ products(first: 100) { id name price } }");

        expect(result.errors).toBeUndefined();
        expect(result.data?.products).toHaveLength(20);
    });

    it("pages with first and after", async () => {
        const result = await run('{ products(first: 3, after: "p02") { id } }');

        expect(result.data?.products).toEqual([{ id: "p03" }, { id: "p04" }, { id: "p05" }]);
    });

    it("resolves a product with its category and inventory", async () => {
        const result = await run(
            '{ product(id: "p01") { id name category { id name } inventory { available reservedAt } } }',
        );

        expect(result.errors).toBeUndefined();
        expect(result.data?.product).toMatchObject({
            id: "p01",
            category: { id: "audio", name: "Audio" },
            inventory: { available: 10, reservedAt: null },
        });
    });

    it("answers null for an unknown product", async () => {
        const result = await run('{ product(id: "nope") { id } }');

        expect(result.errors).toBeUndefined();
        expect(result.data?.product).toBeNull();
    });

    it("lists categories with their products", async () => {
        const result = await run("{ categories { id products { id } } }");

        expect(result.data?.categories).toHaveLength(4);
    });

    it("searches by term", async () => {
        const result = await run("query($t: String!) { search(term: $t) { name } }", {
            t: "recorder",
        });

        expect(result.data?.search).toEqual([{ name: "Field Recorder" }]);
    });

    it("answers now with a parseable timestamp", async () => {
        const result = await run("{ now }");

        expect(Number.isNaN(Date.parse(String(result.data?.now)))).toBe(false);
    });
});

describe("the viewer", () => {
    it("is null without claims", async () => {
        const result = await run("{ me { id } }");

        expect(result.data?.me).toBeNull();
    });

    it("reads the subject, organization and role from the claims", async () => {
        const result = await run("{ me { id organizationId role favourites { id } } }", undefined, {
            sub: "user_1",
            org_id: "org_1",
            role: "admin",
        });

        expect(result.data?.me).toMatchObject({
            id: "user_1",
            organizationId: "org_1",
            role: "admin",
        });
    });

    it("gives two subjects different favourites", async () => {
        const claims = (sub: string) => ({ sub, org_id: "org_1", role: "member" });
        const one = await run("{ me { favourites { id } } }", undefined, claims("user_1"));
        const two = await run("{ me { favourites { id } } }", undefined, claims("user_2"));

        expect(one.data?.me).not.toEqual(two.data?.me);
    });

    it("reports on the claims' organization and role", async () => {
        const result = await run(
            "{ reports(range: WEEK) { organizationId role range } }",
            undefined,
            {
                sub: "user_1",
                org_id: "org_1",
                role: "admin",
            },
        );

        expect(result.data?.reports).toMatchObject({
            organizationId: "org_1",
            role: "admin",
            range: "WEEK",
        });
    });

    it("reports as anonymous without claims", async () => {
        const result = await run("{ reports { organizationId role } }");

        expect(result.data?.reports).toMatchObject({
            organizationId: "anonymous",
            role: "anonymous",
        });
    });
});

describe("mutations", () => {
    it("setPrice changes what the next read returns", async () => {
        await run('mutation { setPrice(id: "p01", price: 9999) { id price } }');
        const after = await run('{ product(id: "p01") { price } }');

        expect(after.data?.product).toMatchObject({ price: 9999 });
    });

    it("addReview shows up on the product", async () => {
        await run(
            'mutation { addReview(input: { productId: "p02", author: "kay", body: "sturdy", rating: 5 }) { id } }',
        );
        const after = await run('{ product(id: "p02") { reviews { author } } }');

        expect(after.data?.product).toMatchObject({ reviews: [{ author: "kay" }] });
    });

    it("reserveStock lowers what is available", async () => {
        await run('mutation { reserveStock(id: "p01", count: 4) { available } }');
        const after = await run('{ product(id: "p01") { inventory { available } } }');

        expect(after.data?.product).toMatchObject({ inventory: { available: 6 } });
    });

    it("renameCategory changes the category on the product", async () => {
        await run('mutation { renameCategory(id: "audio", name: "Sound") { id name } }');
        const after = await run('{ product(id: "p01") { category { name } } }');

        expect(after.data?.product).toMatchObject({ category: { name: "Sound" } });
    });

    it("reports an error for an unknown product instead of crashing", async () => {
        const result = await run('mutation { setPrice(id: "nope", price: 1) { id } }');

        expect(result.errors?.[0]?.message).toMatch(/does not exist/);
    });
});

describe("the store resets", () => {
    it("restores the seed, so the next read sees the seeded price", async () => {
        await run('mutation { setPrice(id: "p01", price: 1) { id } }');
        await store.reset();
        const after = await run('{ product(id: "p01") { price } }');

        expect(after.data?.product).toMatchObject({ price: 1900 });
    });
});
