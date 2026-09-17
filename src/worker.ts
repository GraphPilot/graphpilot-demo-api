import { createYoga, type YogaServerInstance } from "graphql-yoga";
import { claimsFromAuthorization, InvalidTokenError } from "./auth/claims.ts";
import { handleJwksRequest } from "./auth/jwks-endpoint.ts";
import { type DemoKeys, keysFromPrivateJwk } from "./auth/keys.ts";
import { handleTokenRequest } from "./auth/token-endpoint.ts";
import type { DemoContext } from "./resolvers/index.ts";
import { createSchema } from "./schema.ts";
import { verifyOriginSignature } from "./signing/verify.ts";
import { CatalogueObject, DurableObjectStore } from "./store/durable-object-store.ts";

// The Workers entry point. Like `src/node.ts` it owns everything runtime-specific and nothing else:
// the routes, the environment it reads, the store it picks. Everything it imports runs on both.

export { CatalogueObject };

export interface Env {
    CATALOGUE: DurableObjectNamespace<CatalogueObject>;
    /** "false" turns the origin signature guard off, for a local run only. */
    REQUIRE_SIGNATURE?: string | undefined;
    /** The per-service signing key the platform issues. A secret, never in the repository. */
    SIGNING_KEY?: string | undefined;
    /** An RSA private JWK as JSON. Without it the Durable Object keeps a generated one. */
    AUTH_PRIVATE_JWK?: string | undefined;
    /** Only consulted when signatures are off, to keep `/admin/reset` shut anyway. */
    ADMIN_TOKEN?: string | undefined;
}

/** What the edge signs. `/auth/jwks.json` cannot be here, because the edge fetches the key set
 * itself and that fetch is not a signed origin request; `/auth/token` and `/health` are open for
 * the same kind of reason. `/admin/reset` is here because it is the one route that destroys data. */
const SIGNED_PATHS = new Set(["/graphql", "/admin/reset"]);

// Both caches are module scope on purpose. An isolate serves many requests, and rebuilding the
// executable schema or re-importing an RSA key on each one is work the demo would be measured on.
const yogas = new WeakMap<DurableObjectNamespace<CatalogueObject>, YogaInstance>();
const keyCache = new Map<string, Promise<DemoKeys>>();

type YogaInstance = YogaServerInstance<Record<string, unknown>, DemoContext>;

function yogaFor(env: Env): YogaInstance {
    const existing = yogas.get(env.CATALOGUE);
    if (existing) {
        return existing;
    }
    const yoga = createYoga<Record<string, unknown>, DemoContext>({
        schema: createSchema(new DurableObjectStore(env.CATALOGUE)),
        graphqlEndpoint: "/graphql",
        landingPage: false,
        context: (serverContext) => ({
            claims: (serverContext as unknown as DemoContext).claims ?? null,
        }),
    });
    yogas.set(env.CATALOGUE, yoga);
    return yoga;
}

/**
 * The key pair this isolate mints tokens with.
 *
 * A Worker has no startup: every isolate would generate its own pair, and the key set an edge
 * fetched from one isolate would refuse the tokens another isolate handed out. So a configured
 * `AUTH_PRIVATE_JWK` wins, and without one the Durable Object generates a pair once and every
 * isolate reads that same pair back.
 */
function keysFor(env: Env): Promise<DemoKeys> {
    const configured = env.AUTH_PRIVATE_JWK;
    const cacheKey = configured ?? "durable";
    const cached = keyCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const loading = (async () => {
        if (configured) {
            return keysFromPrivateJwk(configured);
        }
        return keysFromPrivateJwk(await new DurableObjectStore(env.CATALOGUE).authPrivateJwk());
    })();
    keyCache.set(cacheKey, loading);
    return loading;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/**
 * `POST /admin/reset` puts the catalogue back to the seed.
 *
 * This endpoint belongs in no real API: it lets a caller destroy every write anyone else has made.
 * It exists because a demo is only readable if the reader can get back to the state the docs
 * describe, and because the system tests need a known starting point. It is guarded the same way
 * the API is, and when signatures are off it still wants `ADMIN_TOKEN`, so switching the guard off
 * for a local run does not hand the reset to whoever finds the address.
 */
async function handleReset(
    request: Request,
    env: Env,
    signatureChecked: boolean,
): Promise<Response> {
    if (request.method !== "POST") {
        return json(405, { error: "POST to restore the seed" });
    }
    if (!signatureChecked) {
        const presented = request.headers.get("x-admin-token");
        if (!env.ADMIN_TOKEN || presented !== env.ADMIN_TOKEN) {
            return json(403, { error: "this endpoint needs a signature or the admin token" });
        }
    }
    await new DurableObjectStore(env.CATALOGUE).reset();
    return json(200, { status: "reset" });
}

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const requireSignature = env.REQUIRE_SIGNATURE !== "false";

        if (requireSignature && !env.SIGNING_KEY) {
            // Refusing is the only safe answer: serving would mean serving unverified traffic while
            // the configuration says the opposite.
            console.error("SIGNING_KEY is not set, and REQUIRE_SIGNATURE is not false");
            return json(500, { error: "this origin is not configured" });
        }

        // The bytes as they arrived. The signature covers exactly these, so nothing may
        // re-serialize them first, and the body can only be read once.
        const body =
            request.method === "GET" || request.method === "HEAD" ? "" : await request.text();

        let signatureChecked = false;
        if (SIGNED_PATHS.has(path)) {
            if (!requireSignature) {
                console.warn(
                    "REQUIRE_SIGNATURE=false: serving an unverified request, so this origin is not protected",
                );
            } else {
                const verification = await verifyOriginSignature(
                    { method: request.method, pathAndQuery: url.pathname + url.search, body },
                    request.headers,
                    { key: env.SIGNING_KEY ?? "" },
                );
                if (!verification.ok) {
                    // The reason is logged, never returned: telling a caller which part of its
                    // forgery was wrong is telling it how to fix the forgery.
                    console.warn(`refused an unsigned request: ${verification.reason}`);
                    return json(401, { error: "this origin only answers signed requests" });
                }
                signatureChecked = true;
            }
        }

        if (path === "/health") {
            return json(200, { status: "ok" });
        }

        if (path === "/admin/reset") {
            return handleReset(request, env, signatureChecked);
        }

        const keys = await keysFor(env);

        if (path === "/auth/jwks.json") {
            const reply = handleJwksRequest(keys);
            return json(reply.status, reply.body);
        }

        if (path === "/auth/token") {
            if (request.method !== "POST") {
                return json(405, { error: "POST a JSON body with sub, org and role" });
            }
            const reply = await handleTokenRequest(body, keys);
            return json(reply.status, reply.body);
        }

        if (path !== "/graphql") {
            return json(404, { error: `nothing is served at ${path}` });
        }

        // Claims are resolved before Yoga runs, so a token that does not verify is answered 401
        // rather than becoming a GraphQL error inside a 200, which the edge would then cache.
        let claims: DemoContext["claims"];
        try {
            claims = await claimsFromAuthorization(request.headers.get("authorization"), keys);
        } catch (error) {
            if (!(error instanceof InvalidTokenError)) {
                throw error;
            }
            return json(401, { error: "the bearer token did not verify" });
        }

        // The body was already read, so Yoga gets a request carrying the same bytes.
        const forwarded = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: body === "" ? null : body,
        });
        return yogaFor(env).fetch(forwarded, { claims });
    },
} satisfies ExportedHandler<Env>;
