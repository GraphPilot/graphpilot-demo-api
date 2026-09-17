import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// graphql 17 publishes a `development` export condition alongside the default one. Left to itself,
// the test runner resolves one import through each, and two copies of graphql in one process refuse
// to recognize each other's schema objects. Naming the conditions pins every import to one copy.
const conditions = ["module", "node", "import", "default"];

// Two projects, because the two entry points run on two runtimes and a test that proves nothing
// about the runtime it targets proves nothing at all. `node` covers the core and `src/node.ts`;
// `workers` runs inside workerd with a real Durable Object, which is the only place the Workers
// entry point, the Durable Object store, and the WebCrypto in `src/auth` and `src/signing` can be
// shown to work.
export default defineConfig({
    test: {
        projects: [
            {
                resolve: { conditions },
                ssr: { resolve: { conditions } },
                test: {
                    name: "node",
                    include: ["src/__tests__/*.test.ts"],
                    environment: "node",
                },
            },
            {
                plugins: [
                    cloudflareTest({
                        wrangler: { configPath: "./wrangler.jsonc" },
                        // What the deployed worker gets from secrets. A test run holds no secrets,
                        // so the guard is off and the reset endpoint falls back to its token.
                        miniflare: {
                            bindings: {
                                REQUIRE_SIGNATURE: "false",
                                ADMIN_TOKEN: "test-admin",
                            },
                        },
                    }),
                ],
                resolve: { conditions },
                test: {
                    name: "workers",
                    include: ["src/__tests__/workers/*.test.ts"],
                },
            },
        ],
    },
});
