import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CatalogueObject } from "../../store/durable-object-store.ts";
import worker, { type Env } from "../../worker.ts";

/**
 * The Durable Object round trips one GraphQL request costs, counted at the stub, through the whole
 * worker. The object lives in one place and an isolate may run on another continent, so this count
 * multiplied by an ocean crossing is the floor of the response time. The ten-level document below
 * once cost 313 of them and timed out at the edge from a US runner.
 */

const ORIGIN = "https://demo.example";

const DEEP = `query($id: ID!) { product(id: $id) { category { products { category { products {
    category { products { category { products { id } } } } } } } } } }`;

/** The namespace, with every RPC made on any stub it hands out written down by method name. */
function countingNamespace(): {
    namespace: DurableObjectNamespace<CatalogueObject>;
    calls: string[];
} {
    const calls: string[] = [];
    const real = env.CATALOGUE;
    const namespace = new Proxy(real, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "get") {
                return typeof value === "function" ? value.bind(target) : value;
            }
            return (id: DurableObjectId) => {
                const stub = target.get(id);
                return new Proxy(stub, {
                    get(stubTarget, method) {
                        const rpc = Reflect.get(stubTarget, method, stubTarget);
                        if (typeof rpc !== "function" || typeof method !== "string") {
                            return rpc;
                        }
                        return (...args: unknown[]) => {
                            calls.push(method);
                            // Reflect.apply, because `.apply` on an RPC method is itself a remote name.
                            return Reflect.apply(rpc, stubTarget, args);
                        };
                    },
                });
            };
        },
    });
    return { namespace, calls };
}

async function graphql(
    workerEnv: Env,
    query: string,
    variables: Record<string, unknown> = {},
): Promise<{ data?: unknown; errors?: unknown }> {
    const context = createExecutionContext();
    const response = await worker.fetch(
        new Request(`${ORIGIN}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables }),
        }),
        workerEnv,
        context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    return (await response.json()) as { data?: unknown; errors?: unknown };
}

/** The catalogue calls only. The key pair is loaded once per isolate and is not the subject. */
function catalogueCalls(calls: string[]): string[] {
    return calls.filter((method) => method !== "authPrivateJwk");
}

describe("Durable Object round trips per request", () => {
    beforeEach(async () => {
        const context = createExecutionContext();
        await worker.fetch(
            new Request(`${ORIGIN}/admin/reset`, {
                method: "POST",
                headers: { "x-admin-token": "test-admin" },
            }),
            { CATALOGUE: env.CATALOGUE, REQUIRE_SIGNATURE: "false", ADMIN_TOKEN: "test-admin" },
            context,
        );
        await waitOnExecutionContext(context);
    });

    it("answers the ten-level document in three round trips", async () => {
        const { namespace, calls } = countingNamespace();

        const payload = await graphql({ CATALOGUE: namespace, REQUIRE_SIGNATURE: "false" }, DEEP, {
            id: "p01",
        });

        expect(payload.errors).toBeUndefined();
        expect(JSON.stringify(payload.data).match(/"id"/g)).toHaveLength(625);
        expect(catalogueCalls(calls).sort()).toEqual(["category", "product", "products"]);
    });

    it("pays again on the next request, so it reads a write made in between", async () => {
        const { namespace, calls } = countingNamespace();
        const workerEnv: Env = { CATALOGUE: namespace, REQUIRE_SIGNATURE: "false" };
        const read = '{ product(id: "p11") { price } }';

        await graphql(workerEnv, read);
        await graphql(workerEnv, 'mutation { setPrice(id: "p11", price: 4242) { id } }');
        const after = await graphql(workerEnv, read);

        expect(after.data).toEqual({ product: { price: 4242 } });
        expect(catalogueCalls(calls)).toEqual(["product", "setPrice", "product"]);
    });

    it("reads a write made earlier in the same request", async () => {
        const { namespace } = countingNamespace();

        const payload = await graphql(
            { CATALOGUE: namespace, REQUIRE_SIGNATURE: "false" },
            `mutation {
                before: setPrice(id: "p07", price: 1) { category { name products { id price } } }
                rename: renameCategory(id: "desks", name: "Tables") { name }
                after: setPrice(id: "p06", price: 4242) { category { name products { id price } } }
            }`,
        );

        expect(payload.errors).toBeUndefined();
        const data = payload.data as Record<
            "before" | "after",
            { category: { name: string; products: { id: string; price: number }[] } }
        >;
        expect(data.before.category.name).toBe("Desks");
        expect(data.after.category.name).toBe("Tables");
        expect(data.after.category.products.find((p) => p.id === "p06")?.price).toBe(4242);
        expect(data.after.category.products.find((p) => p.id === "p07")?.price).toBe(1);
    });
});
