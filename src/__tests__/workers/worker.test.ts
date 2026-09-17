import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seed } from "../../data/seed.ts";
import worker, { type Env } from "../../worker.ts";

/**
 * The Workers entry point, inside workerd. Two things are being proved here that no other test in
 * this repository can prove: that the whole worker answers a GraphQL query over the Durable Object,
 * and that `src/auth` and `src/signing` really run on Workers. Both were written against WebCrypto
 * and the Fetch API on purpose, but "no `node:` import" is an assumption until something runs them
 * here.
 */

const ORIGIN = "https://demo.example";
const SIGNING_KEY = "gpsk_test_key";
const encoder = new TextEncoder();

function envWith(overrides: Partial<Env>): Env {
    return { CATALOGUE: env.CATALOGUE, REQUIRE_SIGNATURE: "false", ...overrides };
}

async function call(request: Request, workerEnv: Env): Promise<Response> {
    const context = createExecutionContext();
    const response = await worker.fetch(request, workerEnv, context);
    await waitOnExecutionContext(context);
    return response;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

async function graphql(
    query: string,
    variables: Record<string, unknown> = {},
    options: { workerEnv?: Env; headers?: Record<string, string> } = {},
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the query asked for.
): Promise<any> {
    const response = await call(
        post("/graphql", { query, variables }, options.headers ?? {}),
        options.workerEnv ?? envWith({}),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data?: unknown; errors?: unknown };
    expect(payload.errors).toBeUndefined();
    return payload.data;
}

/**
 * The signature, built here from the scheme's own description rather than by calling
 * `signCanonicalString`. A test that signs with the code under test only proves the code agrees
 * with itself.
 */
async function signed(path: string, body: string, at = Math.floor(Date.now() / 1000)) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
    const bodyHash = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const canonical = `POST\n${path}\n${at}\n${bodyHash}`;
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(SIGNING_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
    let binary = "";
    for (const byte of raw) {
        binary += String.fromCharCode(byte);
    }
    return { "gp-signature": `v1=${btoa(binary)}`, "gp-timestamp": String(at) };
}

describe("the worker", () => {
    beforeEach(async () => {
        // Every test starts from the seed, so an assertion about a value is about this test's write.
        await call(
            post("/admin/reset", {}, { "x-admin-token": "test-admin" }),
            envWith({ ADMIN_TOKEN: "test-admin" }),
        );
    });

    it("answers the health probe without a signature", async () => {
        const response = await call(new Request(`${ORIGIN}/health`), envWith({}));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok" });
    });

    it("answers a GraphQL query over the Durable Object", async () => {
        const data = await graphql("{ products { id name price } }");
        expect(data.products).toHaveLength(20);
        expect(data.products[0]).toEqual({
            id: "p01",
            name: seed().products[0]?.name,
            price: seed().products[0]?.price,
        });
    });

    it("serves a mutation's value on the very next query", async () => {
        const mutated = await graphql(
            "mutation($id: ID!, $price: Int!) { setPrice(id: $id, price: $price) { id price } }",
            { id: "p05", price: 31337 },
        );
        expect(mutated.setPrice.price).toBe(31337);

        const read = await graphql("query($id: ID!) { product(id: $id) { price } }", { id: "p05" });
        expect(read.product.price).toBe(31337);
    });

    it("mints a token, publishes the key that verifies it, and resolves me from it", async () => {
        const minted = await call(
            post("/auth/token", { sub: "u-1", org: "org-1", role: "admin" }),
            envWith({}),
        );
        expect(minted.status).toBe(200);
        const { token, expiresIn } = (await minted.json()) as {
            token: string;
            expiresIn: number;
        };
        expect(expiresIn).toBe(3600);

        const jwks = await call(new Request(`${ORIGIN}/auth/jwks.json`), envWith({}));
        expect(jwks.status).toBe(200);
        const published = (await jwks.json()) as { keys: Array<Record<string, unknown>> };
        expect(published.keys[0]?.kty).toBe("RSA");
        // The private half never leaves the process, on Workers as on Node.
        expect(published.keys[0]?.d).toBeUndefined();

        const data = await graphql(
            "{ me { id organizationId role } }",
            {},
            {
                headers: { authorization: `Bearer ${token}` },
            },
        );
        expect(data.me).toMatchObject({ id: "u-1", organizationId: "org-1", role: "admin" });
    });

    it("keeps one signing key across isolates, so a token minted here verifies there", async () => {
        // Two calls are two separate `loadKeys` paths; the key set must not change between them.
        const first = await call(new Request(`${ORIGIN}/auth/jwks.json`), envWith({}));
        const second = await call(new Request(`${ORIGIN}/auth/jwks.json`), envWith({}));
        const a = (await first.json()) as { keys: Array<{ kid?: string }> };
        const b = (await second.json()) as { keys: Array<{ kid?: string }> };
        expect(a.keys[0]?.kid).toBe(b.keys[0]?.kid);
    });

    it("refuses a bearer token that does not verify", async () => {
        const response = await call(
            post("/graphql", { query: "{ me { id } }" }, { authorization: "Bearer not-a-token" }),
            envWith({}),
        );
        expect(response.status).toBe(401);
    });

    it("refuses an unsigned request and accepts a signed one", async () => {
        const guarded = envWith({ REQUIRE_SIGNATURE: "true", SIGNING_KEY });
        const body = JSON.stringify({ query: "{ categories { id } }" });

        const unsigned = await call(post("/graphql", JSON.parse(body)), guarded);
        expect(unsigned.status).toBe(401);

        const response = await call(
            new Request(`${ORIGIN}/graphql`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(await signed("/graphql", body)),
                },
                body,
            }),
            guarded,
        );
        expect(response.status).toBe(200);
        const payload = (await response.json()) as { data: { categories: unknown[] } };
        expect(payload.data.categories).toHaveLength(4);
    });

    it("refuses a signature whose timestamp is outside the window", async () => {
        const guarded = envWith({ REQUIRE_SIGNATURE: "true", SIGNING_KEY });
        const body = JSON.stringify({ query: "{ categories { id } }" });
        const stale = await signed("/graphql", body, Math.floor(Date.now() / 1000) - 400);

        const response = await call(
            new Request(`${ORIGIN}/graphql`, {
                method: "POST",
                headers: { "content-type": "application/json", ...stale },
                body,
            }),
            guarded,
        );
        expect(response.status).toBe(401);
    });

    it("restores the seed on /admin/reset", async () => {
        await graphql(
            "mutation($id: ID!, $price: Int!) { setPrice(id: $id, price: $price) { price } }",
            { id: "p07", price: 1 },
        );

        const reset = await call(
            post("/admin/reset", {}, { "x-admin-token": "test-admin" }),
            envWith({ ADMIN_TOKEN: "test-admin" }),
        );
        expect(reset.status).toBe(200);

        const read = await graphql("query($id: ID!) { product(id: $id) { price } }", { id: "p07" });
        expect(read.product.price).toBe(seed().products[6]?.price);
    });

    it("guards /admin/reset with the signature when signatures are on", async () => {
        const guarded = envWith({ REQUIRE_SIGNATURE: "true", SIGNING_KEY });
        const unsigned = await call(post("/admin/reset", {}), guarded);
        expect(unsigned.status).toBe(401);
    });

    it("guards /admin/reset with the admin token when signatures are off", async () => {
        const open = envWith({ ADMIN_TOKEN: "test-admin" });
        expect((await call(post("/admin/reset", {}), open)).status).toBe(403);
        expect(
            (await call(post("/admin/reset", {}, { "x-admin-token": "wrong" }), open)).status,
        ).toBe(403);
        // With no token configured and no signature required, there is nothing left to check
        // against, so the endpoint stays shut rather than opening itself.
        expect((await call(post("/admin/reset", {}), envWith({}))).status).toBe(403);
    });

    it("answers 404 for a path it does not serve", async () => {
        const response = await call(new Request(`${ORIGIN}/nope`), envWith({}));
        expect(response.status).toBe(404);
    });
});
