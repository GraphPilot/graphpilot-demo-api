import { type GraphQLSchema, graphql } from "graphql";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIENCE, claimsFromAuthorization, InvalidTokenError, ISSUER } from "../auth/claims.ts";
import { handleJwksRequest } from "../auth/jwks-endpoint.ts";
import { type DemoKeys, generateKeys, keysFromPrivateJwk, loadKeys } from "../auth/keys.ts";
import { handleTokenRequest, mintToken, TOKEN_TTL_SECONDS } from "../auth/token-endpoint.ts";
import type { DemoContext } from "../resolvers/index.ts";
import { createSchema } from "../schema.ts";
import { MemoryStore } from "../store/memory-store.ts";

let keys: DemoKeys;

beforeAll(async () => {
    keys = await generateKeys();
});

/** The published key set, in the shape `jose` reads. */
function publishedJwks(): { keys: unknown[] } {
    return handleJwksRequest(keys).body as { keys: unknown[] };
}

describe("the key pair", () => {
    it("publishes only the public half", () => {
        const [jwk] = publishedJwks().keys as Record<string, unknown>[];

        expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
        expect(jwk).toHaveProperty("kid");
        expect(jwk).not.toHaveProperty("d");
    });

    // A restart that mints a new pair invalidates every token already handed out, which is why
    // production reads the pair from configuration instead of generating one.
    it("survives a restart when the private key comes from configuration", async () => {
        const restarted = await keysFromPrivateJwk(keys.privateJwk);

        expect(restarted.kid).toBe(keys.kid);

        const { token } = await mintToken(keys, { sub: "u1", org: "acme", role: "viewer" });
        const verified = await jwtVerify(token, createLocalJWKSet(publishedJwks() as never), {
            issuer: ISSUER,
            audience: AUDIENCE,
        });

        expect(verified.payload.sub).toBe("u1");
    });

    it("generates a pair when configuration carries none", async () => {
        const generated = await loadKeys({});

        expect(generated.kid).toEqual(expect.any(String));
    });

    it("reads a configured pair back", async () => {
        const configured = await loadKeys({ privateJwk: JSON.stringify(keys.privateJwk) });

        expect(configured.kid).toBe(keys.kid);
    });
});

describe("POST /auth/token", () => {
    it("mints a token that verifies against the published JWKS and carries the three claims", async () => {
        const reply = await handleTokenRequest(
            JSON.stringify({ sub: "u-1", org: "org-acme", role: "admin" }),
            keys,
        );

        expect(reply.status).toBe(200);
        const { token, expiresIn } = reply.body as { token: string; expiresIn: number };
        expect(expiresIn).toBe(TOKEN_TTL_SECONDS);

        const { payload } = await jwtVerify(token, createLocalJWKSet(publishedJwks() as never), {
            issuer: ISSUER,
            audience: AUDIENCE,
        });

        expect(payload).toMatchObject({ sub: "u-1", org_id: "org-acme", role: "admin" });
    });

    it("names the key it signed with, so a rotated set still verifies", async () => {
        const { token } = await mintToken(keys, { sub: "u-1", org: "org-acme", role: "admin" });

        expect(decodeProtectedHeader(token)).toMatchObject({ alg: "RS256", kid: keys.kid });
    });

    it("expires the token", async () => {
        const { token } = await mintToken(keys, { sub: "u-1", org: "org-acme", role: "admin" });
        const { iat, exp } = decodeJwt(token);

        expect((exp ?? 0) - (iat ?? 0)).toBe(TOKEN_TTL_SECONDS);
    });

    it("refuses a body that is not the three fields", async () => {
        for (const body of ['{"sub":"u"}', "{}", "not json", '{"sub":1,"org":"o","role":"r"}']) {
            const reply = await handleTokenRequest(body, keys);

            expect(reply.status).toBe(400);
        }
    });
});

describe("reading a token on the way in", () => {
    it("answers no claims when there is no authorization header", async () => {
        expect(await claimsFromAuthorization(undefined, keys)).toBeNull();
    });

    it("returns the three claims from a valid bearer token", async () => {
        const { token } = await mintToken(keys, { sub: "u-2", org: "org-b", role: "viewer" });

        expect(await claimsFromAuthorization(`Bearer ${token}`, keys)).toEqual({
            sub: "u-2",
            org_id: "org-b",
            role: "viewer",
        });
    });

    it("refuses a token signed by somebody else", async () => {
        const other = await generateKeys();
        const { token } = await mintToken(other, { sub: "u-2", org: "org-b", role: "viewer" });

        await expect(claimsFromAuthorization(`Bearer ${token}`, keys)).rejects.toBeInstanceOf(
            InvalidTokenError,
        );
    });

    it("takes an API key as a caller carrying no claims, rather than refusing it", async () => {
        // The distinction the whole api-key lesson rests on, and it is not a nicety. An API key is
        // opaque, so nothing here can verify it and nothing is meant to; what matters is that it
        // is somebody's credential rather than a malformed token.
        //
        // Refused, it would be a 401, which the edge does not store either, but for an entirely
        // different reason (`CACHE_SKIPPED_ERROR_STATUS`). A walkthrough or a system test reading
        // that code would be measuring this origin's refusal instead of the edge's partitioning
        // rule, which is precisely what both were doing until graphpilot-proxy#474 added the status
        // code and made the two tell apart.
        expect(await claimsFromAuthorization("Bearer demo_sk_anything", keys)).toBeNull();
    });

    it("refuses a garbled token", async () => {
        await expect(claimsFromAuthorization("Bearer nonsense", keys)).rejects.toBeInstanceOf(
            InvalidTokenError,
        );
    });

    it("refuses an authorization header that is not a bearer token", async () => {
        await expect(claimsFromAuthorization("Basic abc", keys)).rejects.toBeInstanceOf(
            InvalidTokenError,
        );
    });
});

describe("the resolvers behind a verified token", () => {
    let schema: GraphQLSchema;

    beforeEach(() => {
        schema = createSchema(new MemoryStore());
    });

    async function runAs(authorization: string | undefined) {
        const claims = await claimsFromAuthorization(authorization, keys);
        return graphql({
            schema,
            source: "{ me { id organizationId role favourites { id } } reports { organizationId role revenue } }",
            contextValue: { claims } satisfies DemoContext,
        });
    }

    it("answers me from the token, and two subjects see different data", async () => {
        const first = await mintToken(keys, { sub: "u-one", org: "org-a", role: "viewer" });
        const second = await mintToken(keys, { sub: "u-two", org: "org-a", role: "viewer" });

        const one = await runAs(`Bearer ${first.token}`);
        const two = await runAs(`Bearer ${second.token}`);

        expect(one.errors).toBeUndefined();
        expect(one.data?.me).toMatchObject({ id: "u-one", organizationId: "org-a" });
        expect(two.data?.me).toMatchObject({ id: "u-two", organizationId: "org-a" });
        expect(one.data?.me).not.toEqual(two.data?.me);
    });

    it("answers no viewer without a token", async () => {
        const result = await runAs(undefined);

        expect(result.data?.me).toBeNull();
        expect(result.data?.reports).toMatchObject({
            organizationId: "anonymous",
            role: "anonymous",
        });
    });

    it("reads organization and role for reports", async () => {
        const { token } = await mintToken(keys, { sub: "u-3", org: "org-c", role: "admin" });

        const result = await runAs(`Bearer ${token}`);

        expect(result.data?.reports).toMatchObject({ organizationId: "org-c", role: "admin" });
    });
});
