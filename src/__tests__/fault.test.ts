// Failing on request: the header that asks for it, the counter behind it, and the schema field.
//
// The demo's whole subject is the cache working. These two levers exist for the other half, what
// the edge does when the origin does not cooperate, and they are worth their own tests because a
// fault injector that quietly stops injecting is indistinguishable from a product that stopped
// failing. A system test built on this would then go green for the wrong reason, which is the exact
// failure mode the system-test suite was written to avoid.

import { type ExecutionResult, type GraphQLSchema, graphql } from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import { faultFromHeaders } from "../fault.ts";
import { createSchema } from "../schema.ts";
import { MemoryStore } from "../store/memory-store.ts";
import { FAULT_NONCE_MAX_LENGTH, FAULT_TIMES_MAX, FAULT_TTL_MS } from "../store/port.ts";

function headers(values: Record<string, string>): Headers {
    return new Headers(values);
}

describe("the header that asks for a transient failure", () => {
    it("is absent unless a nonce names the run", () => {
        expect(faultFromHeaders(headers({}))).toBeUndefined();
        expect(faultFromHeaders(headers({ "x-demo-fail-times": "2" }))).toBeUndefined();
    });

    it("defaults to refusing one attempt with 503", () => {
        // 503 rather than 500, because the default `[origin.retry] status_codes` list is the three
        // gateway statuses. A default the proxy would not retry would make the header useless for
        // the one thing it exists to demonstrate.
        expect(faultFromHeaders(headers({ "x-demo-fail-nonce": "abc" }))).toEqual({
            nonce: "abc",
            times: 1,
            status: 503,
        });
    });

    it("takes the count and the status the request asked for", () => {
        expect(
            faultFromHeaders(
                headers({
                    "x-demo-fail-nonce": "abc",
                    "x-demo-fail-times": "3",
                    "x-demo-fail-status": "504",
                }),
            ),
        ).toEqual({ nonce: "abc", times: 3, status: 504 });
    });

    it("reads a plain lowercase record, so the Node entry point behaves like the Worker", () => {
        // `src/node.ts` hands over `IncomingMessage.headers`, which is an object and not `Headers`.
        // The two entry points sharing one reader is what keeps a local walkthrough honest about
        // the deployed demo.
        expect(faultFromHeaders({ "x-demo-fail-nonce": "abc" })).toEqual({
            nonce: "abc",
            times: 1,
            status: 503,
        });
    });

    it("ignores a status the proxy would not retry, rather than teaching the wrong list", () => {
        // A 500 is an application answering. Honouring it here would invite a reader to conclude
        // the edge retries one, which it does not.
        for (const status of ["500", "429", "200", "nonsense"]) {
            expect(
                faultFromHeaders(
                    headers({ "x-demo-fail-nonce": "abc", "x-demo-fail-status": status }),
                ),
                `status ${status} must not be accepted`,
            ).toBeUndefined();
        }
    });

    it("refuses to be asked for more failures than the ceiling, or for a junk count", () => {
        for (const times of [String(FAULT_TIMES_MAX + 1), "0", "-1", "abc"]) {
            expect(
                faultFromHeaders(
                    headers({ "x-demo-fail-nonce": "abc", "x-demo-fail-times": times }),
                ),
                `times ${times} must not be accepted`,
            ).toBeUndefined();
        }
    });

    it("refuses a nonce longer than the ceiling, so this cannot store arbitrary text", () => {
        const tooLong = "n".repeat(FAULT_NONCE_MAX_LENGTH + 1);
        expect(faultFromHeaders(headers({ "x-demo-fail-nonce": tooLong }))).toBeUndefined();
        expect(
            faultFromHeaders(headers({ "x-demo-fail-nonce": "n".repeat(FAULT_NONCE_MAX_LENGTH) })),
        ).toBeDefined();
    });
});

describe("the counter behind it", () => {
    it("refuses exactly the number of attempts asked for, then answers", async () => {
        // The property the whole retry scenario rests on. An origin that refused forever would
        // prove the edge gives up; an origin that refused once and then forgot would prove nothing
        // at all, because the second attempt would be refused too.
        const store = new MemoryStore();

        expect(await store.consumeFault("run-1", 2)).toBe(true);
        expect(await store.consumeFault("run-1", 2)).toBe(true);
        expect(await store.consumeFault("run-1", 2)).toBe(false);
        expect(await store.consumeFault("run-1", 2)).toBe(false);
    });

    it("counts each run on its own, so one caller's failure is never another's", async () => {
        const store = new MemoryStore();

        expect(await store.consumeFault("run-a", 1)).toBe(true);
        expect(await store.consumeFault("run-b", 1)).toBe(true);
        expect(await store.consumeFault("run-a", 1)).toBe(false);
        expect(await store.consumeFault("run-b", 1)).toBe(false);
    });

    it("forgets a run once it is older than the window", async () => {
        // Otherwise a caller that asks for two failures and gives up after one leaves its row
        // behind forever, and this runs on a public demo.
        let now = new Date("2026-09-24T10:00:00.000Z");
        const store = new MemoryStore(() => now);

        expect(await store.consumeFault("stale", 1)).toBe(true);
        expect(await store.consumeFault("stale", 1)).toBe(false);

        now = new Date(now.getTime() + FAULT_TTL_MS + 1);
        expect(
            await store.consumeFault("stale", 1),
            "a forgotten run is indistinguishable from one that was never used",
        ).toBe(true);
    });
});

describe("the schema field that fails", () => {
    let schema: GraphQLSchema;

    beforeEach(() => {
        schema = createSchema(new MemoryStore());
    });

    function run(source: string): Promise<ExecutionResult> {
        return graphql({ schema, source, contextValue: { claims: null } });
    }

    it("answers normally when it is not asked to fail, which is the control", async () => {
        // Load-bearing. "The edge did not store it" only means something if the same operation
        // without the failure IS stored, and that requires this to be an ordinary answer.
        const result = await run('{ faulty(nonce: "n1") { nonce observedAt } }');

        expect(result.errors).toBeUndefined();
        expect((result.data?.faulty as { nonce: string } | undefined)?.nonce).toBe("n1");
    });

    it("throws with no data at all when asked to fail", async () => {
        // `faulty` is `Fault!`, so a throw in its own resolver has no nullable position to stop at
        // and nulls `data` outright. That is the plain case: errors, and nothing usable beside them.
        const result = await run('{ faulty(nonce: "n2", fail: true) { nonce } }');

        expect(result.errors?.length).toBe(1);
        expect(result.data).toBeNull();
    });

    it("leaves the rest of the answer standing when only the broken field is selected", async () => {
        // The shape the edge's rule is really about: data and errors in one response. A test that
        // only ever produced the all-or-nothing case above would never exercise it, and partial
        // data is the case where refusing to store actually costs the customer something.
        const result = await run('{ faulty(nonce: "n3") { nonce observedAt broken } }');

        expect(result.errors?.length).toBe(1);
        expect(result.errors?.[0]?.path).toEqual(["faulty", "broken"]);
        expect(
            (result.data?.faulty as { nonce: string } | null)?.nonce,
            "the fields that resolved must survive the one that did not",
        ).toBe("n3");
    });

    it("names itself in the message, because that message reaches the customer", async () => {
        // It ends up in the client's `errors` array and in the portal's GraphQL tab. "Error" on its
        // own would send a reader looking for a defect that is not there.
        const result = await run('{ faulty(nonce: "n4", fail: true) { nonce } }');

        expect(result.errors?.[0]?.message).toMatch(/Query\.faulty was asked to fail/);
        expect(result.errors?.[0]?.message).toMatch(/n4/);
    });
});
