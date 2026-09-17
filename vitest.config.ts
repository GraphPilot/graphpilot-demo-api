import { defineConfig } from "vitest/config";

// graphql 17 publishes a `development` export condition alongside the default one. Left to itself,
// the test runner resolves one import through each, and two copies of graphql in one process refuse
// to recognize each other's schema objects. Naming the conditions pins every import to one copy.
const conditions = ["module", "node", "import", "default"];

export default defineConfig({
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
