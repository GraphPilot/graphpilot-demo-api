import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "../../data/seed.ts";

/**
 * The worker as the outside world meets it: every call goes over a real request boundary, dispatched
 * by the runtime rather than by calling `fetch` on the module.
 *
 * That distinction is the whole reason this file exists. A Durable Object stub is an I/O object owned
 * by the request that created it, and a stub held in a module-scope cache is refused on the next
 * request with "Cannot perform I/O on behalf of a different request". Calling the handler directly
 * never crosses that boundary and so never notices.
 */

const ORIGIN = "https://demo.example";

async function graphql(
    query: string,
    variables: Record<string, unknown> = {},
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the query asked for.
): Promise<any> {
    const response = await SELF.fetch(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data?: unknown; errors?: unknown };
    expect(payload.errors).toBeUndefined();
    return payload.data;
}

async function reset(): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/admin/reset`, {
        method: "POST",
        headers: { "x-admin-token": "test-admin" },
    });
}

describe("the deployed shape of the worker", () => {
    beforeEach(async () => {
        expect((await reset()).status).toBe(200);
    });

    it("answers the health probe", async () => {
        const response = await SELF.fetch(`${ORIGIN}/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok" });
    });

    it("answers a query, and the request after it", async () => {
        expect((await graphql("{ categories { id name } }")).categories).toHaveLength(4);
        expect((await graphql("{ products { id } }")).products).toHaveLength(20);
    });

    it("serves a mutation's value on the next request, not just later in the same one", async () => {
        const written = await graphql(
            "mutation($id: ID!, $price: Int!) { setPrice(id: $id, price: $price) { price } }",
            { id: "p09", price: 27272 },
        );
        expect(written.setPrice.price).toBe(27272);

        const read = await graphql("query($id: ID!) { product(id: $id) { price } }", { id: "p09" });
        expect(read.product.price).toBe(27272);
    });

    it("accepts a GraphQL input object as a mutation argument", async () => {
        // A GraphQL input value has a null prototype, and structured clone refuses to send one to a
        // Durable Object. Nothing in the unit tests can notice, because a test writes a literal.
        const written = await graphql(
            "mutation($input: ReviewDraft!) { addReview(input: $input) { id body author } }",
            { input: { productId: "p04", author: "a-reader", body: "unique body", rating: 4 } },
        );
        expect(written.addReview.body).toBe("unique body");

        const read = await graphql("query($id: ID!) { product(id: $id) { reviews { body } } }", {
            id: "p04",
        });
        expect(read.product.reviews.map((review: { body: string }) => review.body)).toContain(
            "unique body",
        );
    });

    it("reserves stock and shows it gone on the next request", async () => {
        const before = await graphql(
            "query($id: ID!) { product(id: $id) { inventory { available } } }",
            {
                id: "p04",
            },
        );
        await graphql("mutation($id: ID!) { reserveStock(id: $id, count: 2) { available } }", {
            id: "p04",
        });
        const after = await graphql(
            "query($id: ID!) { product(id: $id) { inventory { available } } }",
            {
                id: "p04",
            },
        );
        expect(after.product.inventory.available).toBe(before.product.inventory.available - 2);
    });

    it("restores the seed on /admin/reset, across requests", async () => {
        await graphql(
            "mutation($id: ID!, $price: Int!) { setPrice(id: $id, price: $price) { price } }",
            { id: "p09", price: 1 },
        );
        expect((await reset()).status).toBe(200);

        const read = await graphql("query($id: ID!) { product(id: $id) { price } }", { id: "p09" });
        expect(read.product.price).toBe(seed().products[8]?.price);
    });

    it("mints a token and resolves me from it on a later request", async () => {
        const minted = await SELF.fetch(`${ORIGIN}/auth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sub: "u-self", org: "org-self", role: "viewer" }),
        });
        expect(minted.status).toBe(200);
        const { token } = (await minted.json()) as { token: string };

        const response = await SELF.fetch(`${ORIGIN}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ query: "{ me { id organizationId role } }" }),
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as { data: { me: unknown } };
        expect(payload.data.me).toMatchObject({
            id: "u-self",
            organizationId: "org-self",
            role: "viewer",
        });
    });
});
