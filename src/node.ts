import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { claimsFromAuthorization, InvalidTokenError } from "./auth/claims.ts";
import { handleJwksRequest } from "./auth/jwks-endpoint.ts";
import { loadKeys } from "./auth/keys.ts";
import { handleTokenRequest } from "./auth/token-endpoint.ts";
import type { DemoContext } from "./resolvers/index.ts";
import { createSchema } from "./schema.ts";
import { verifyOriginSignature } from "./signing/verify.ts";
import { MemoryStore } from "./store/memory-store.ts";

// The Node entry point. It owns everything runtime-specific: the port, the process, the store it
// picks, the environment it reads. Everything it imports runs unchanged on Workers.

const port = Number(process.env.PORT ?? 4000);
const signingKey = process.env.SIGNING_KEY ?? "";
// Off for a local run, where nothing signs the request. Anything reachable from the internet
// leaves it on, or the origin is open to whoever finds its address.
const requireSignature = process.env.REQUIRE_SIGNATURE !== "false";

/** Only the API surface is signed. The edge fetches the key set and mints tokens without a
 * signature, and `/health` is probed by things that hold no key. */
const SIGNED_PATHS = new Set(["/graphql"]);

const store = new MemoryStore();
const keys = await loadKeys({ privateJwk: process.env.AUTH_PRIVATE_JWK });

if (requireSignature && !signingKey) {
    throw new Error("SIGNING_KEY is required unless REQUIRE_SIGNATURE=false");
}

// Claims are resolved before Yoga runs, so a token that does not verify is answered 401 rather
// than becoming a GraphQL error inside a 200.
const yoga = createYoga<DemoContext, DemoContext>({
    schema: createSchema(store),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    context: (serverContext) => ({ claims: serverContext.claims ?? null }),
});

function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

/** The bytes as they arrived. The signature covers these, so nothing may re-serialize them first. */
async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const body =
        request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);

    if (SIGNED_PATHS.has(path)) {
        if (!requireSignature) {
            console.warn(
                "REQUIRE_SIGNATURE=false: serving an unverified request, so this origin is not protected",
            );
        } else {
            const verification = await verifyOriginSignature(
                { method: request.method ?? "GET", pathAndQuery: request.url ?? "/", body },
                request.headers,
                { key: signingKey },
            );
            if (!verification.ok) {
                // The reason is logged, never returned: telling a caller which part of its forgery
                // was wrong is telling it how to fix the forgery.
                console.warn(`refused an unsigned request: ${verification.reason}`);
                send(response, 401, { error: "this origin only answers signed requests" });
                return;
            }
        }
    }

    if (path === "/health") {
        send(response, 200, { status: "ok" });
        return;
    }

    if (path === "/auth/jwks.json") {
        const reply = handleJwksRequest(keys);
        send(response, reply.status, reply.body);
        return;
    }

    if (path === "/auth/token") {
        if (request.method !== "POST") {
            send(response, 405, { error: "POST a JSON body with sub, org and role" });
            return;
        }
        const reply = await handleTokenRequest(body, keys);
        send(response, reply.status, reply.body);
        return;
    }

    // Yoga reads the body off the request stream, which this handler has already drained, so hand
    // it the bytes that were read instead.
    if (body) {
        (request as IncomingMessage & { body?: string }).body = body;
    }

    let claims: DemoContext["claims"];
    try {
        claims = await claimsFromAuthorization(request.headers.authorization, keys);
    } catch (error) {
        if (!(error instanceof InvalidTokenError)) {
            throw error;
        }
        send(response, 401, { error: "the bearer token did not verify" });
        return;
    }

    await yoga(request, response, { claims });
});

server.listen(port, () => {
    console.log(`demo API on http://localhost:${port}/graphql`);
});
