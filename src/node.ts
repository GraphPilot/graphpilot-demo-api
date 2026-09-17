import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import type { DemoContext } from "./resolvers/index.ts";
import { createSchema } from "./schema.ts";
import { MemoryStore } from "./store/memory-store.ts";

// The Node entry point. It owns everything runtime-specific: the port, the process, the store it
// picks. Everything it imports runs unchanged on Workers.

const port = Number(process.env.PORT ?? 4000);
const store = new MemoryStore();

const yoga = createYoga<Record<string, never>, DemoContext>({
    schema: createSchema(store),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    // TODO(auth): verify the bearer token against the demo's own JWKS and pass the claims here.
    // Until `src/auth/` exists, every caller is anonymous and nothing identity-bound is answered.
    context: () => ({ claims: null }),
});

const server = createServer(async (request, response) => {
    // TODO(signing): verify the origin signature here, before anything else runs. A request that
    // fails verification is answered 401 and never reaches a resolver. `src/signing/` owns it.

    if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
    }

    await yoga(request, response);
});

server.listen(port, () => {
    console.log(`demo API on http://localhost:${port}/graphql`);
});
