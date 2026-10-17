import { gzipSync } from "node:zlib";
import { createYoga } from "graphql-yoga";
import { describe, expect, it } from "vitest";
import type { DemoContext } from "../resolvers/index.ts";
import { createSchema } from "../schema.ts";
import { envelopeBytes, SIZED_MAX_BYTES } from "../sized.ts";
import { MemoryStore } from "../store/memory-store.ts";

/**
 * `Query.sized(bytes:)` promises the size of the HTTP body, not of the field, so it is measured
 * where the body exists: through Yoga, the same handler both entry points serve, as raw bytes.
 */

const yoga = createYoga<DemoContext, DemoContext>({
    schema: createSchema(new MemoryStore()),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    context: () => ({ claims: null }),
});

async function post(body: unknown): Promise<{ status: number; bytes: Uint8Array }> {
    const response = await yoga.fetch("http://demo.local/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** The documents the #792 session sheet sends, byte for byte. */
const SIZES = [2_048, 10_240, 10_241, 25_600];

describe("Query.sized", () => {
    it.each(SIZES)("answers a body of exactly %i bytes", async (bytes) => {
        const { status, bytes: body } = await post({
            query: `query Sized { sized(bytes: ${bytes}) }`,
        });

        expect(status).toBe(200);
        expect(body.byteLength).toBe(bytes);
        expect(JSON.parse(new TextDecoder().decode(body))).not.toHaveProperty("errors");
    });

    it("keeps the size exact with variables, a nonce and an alias", async () => {
        const { bytes: body } = await post({
            query: "query Sized($bytes: Int!, $nonce: String) { padded: sized(bytes: $bytes, nonce: $nonce) }",
            variables: { bytes: 10_241, nonce: "run-1729000000" },
        });

        expect(body.byteLength).toBe(10_241);
        expect(new TextDecoder().decode(body).startsWith('{"data":{"padded":"')).toBe(true);
    });

    it("answers the same body whatever the nonce, so only the cache key changes", async () => {
        const first = await post({ query: '{ sized(bytes: 4096, nonce: "a-nonce-1") }' });
        const second = await post({ query: '{ sized(bytes: 4096, nonce: "a-nonce-2") }' });

        expect(first.bytes).toEqual(second.bytes);
    });

    it("compresses well, so a gzip copy is clearly smaller than the billed size", async () => {
        const { bytes: body } = await post({ query: "{ sized(bytes: 25600) }" });

        expect(gzipSync(body).byteLength).toBeLessThan(body.byteLength / 10);
    });

    it("accepts the envelope alone and the ceiling", async () => {
        const smallest = envelopeBytes("sized");
        expect((await post({ query: `{ sized(bytes: ${smallest}) }` })).bytes.byteLength).toBe(
            smallest,
        );
        expect(
            (await post({ query: `{ sized(bytes: ${SIZED_MAX_BYTES}) }` })).bytes.byteLength,
        ).toBe(SIZED_MAX_BYTES);
    });

    it.each([
        ["below the envelope", "{ sized(bytes: 5) }"],
        ["above the ceiling", `{ sized(bytes: ${SIZED_MAX_BYTES + 1}) }`],
        ["beside another field", "{ sized(bytes: 4096) now }"],
        ["beside __typename", "{ __typename sized(bytes: 4096) }"],
    ])("refuses a size it could not keep: %s", async (_case, query) => {
        const { bytes: body } = await post({ query });
        const payload = JSON.parse(new TextDecoder().decode(body)) as {
            errors?: { extensions?: { code?: string } }[];
        };

        expect(payload.errors?.[0]?.extensions?.code).toBe("DEMO_SIZED_INVALID");
    });
});
