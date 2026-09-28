// Misbehaving on request: the headers that ask for it, the scoping rule that makes asking safe,
// and the echo.
//
// The scoping half is the part worth testing hardest. A lever that applies to a shared document is
// not a demo feature, it is a cache poisoning endpoint on a public URL, and the difference between
// the two is one `includes` nobody would notice going missing: everything a walkthrough does would
// still work, and the only visible symptom would be somebody else's response.

import { describe, expect, it } from "vitest";
import {
    behaviourFromHeaders,
    behaviourHeaders,
    DELAY_MAX_MS,
    ECHO_MAX_BYTES,
    ECHO_NAME_MAX_LENGTH,
    ECHO_NAMES_MAX,
    ECHO_RESPONSE_HEADER,
    HEADER_VALUE_MAX_LENGTH,
    isInScope,
    SCOPE_NONCE_MAX_LENGTH,
    SCOPE_NONCE_MIN_LENGTH,
    scopedBehaviour,
} from "../misbehave.ts";

const NONCE = "lever-12345";

function headers(values: Record<string, string>): Headers {
    return new Headers(values);
}

/** A body the scoping rule accepts: the nonce, beside the field that owns its own cache key. */
function scopedBody(nonce = NONCE): string {
    return JSON.stringify({
        query: "query L($n: String!) { faulty(nonce: $n) { nonce observedAt } }",
        variables: { n: nonce },
    });
}

describe("the headers that ask the origin to misbehave", () => {
    it("asks for nothing without a scope nonce", () => {
        // Every lever is inert on its own. The nonce is not an extra argument to them, it is the
        // thing that makes them applicable at all.
        expect(
            behaviourFromHeaders(headers({ "x-demo-cache-control": "max-age=60" })),
        ).toBeUndefined();
        expect(behaviourFromHeaders(headers({ "x-demo-delay-ms": "100" }))).toBeUndefined();
    });

    it("asks for nothing when the nonce names no lever", () => {
        expect(behaviourFromHeaders(headers({ "x-demo-scope-nonce": NONCE }))).toBeUndefined();
    });

    it("takes the three header levers and the delay verbatim", () => {
        expect(
            behaviourFromHeaders(
                headers({
                    "x-demo-scope-nonce": NONCE,
                    "x-demo-cache-control": "public, max-age=31536000",
                    "x-demo-set-cookie": "sid=abc; Path=/",
                    "x-demo-surrogate-key": "invented-key",
                    "x-demo-delay-ms": "250",
                }),
            ),
        ).toEqual({
            nonce: NONCE,
            cacheControl: "public, max-age=31536000",
            setCookie: "sid=abc; Path=/",
            surrogateKey: "invented-key",
            delayMs: 250,
        });
    });

    it("reads a plain lowercase record, so the Node entry point behaves like the Worker", () => {
        // `src/node.ts` hands over `IncomingMessage.headers`, which is an object and not `Headers`.
        expect(
            behaviourFromHeaders({
                "x-demo-scope-nonce": NONCE,
                "x-demo-cache-control": "no-store",
            }),
        ).toEqual({ nonce: NONCE, cacheControl: "no-store", delayMs: 0 });
    });

    it("refuses a nonce too short to be anyone's own", () => {
        // The scoping argument is "nobody else is sending this value". A three character nonce is
        // not that, and honouring it would let two callers collide on one entry by accident.
        const tooShort = "n".repeat(SCOPE_NONCE_MIN_LENGTH - 1);
        expect(
            behaviourFromHeaders(
                headers({ "x-demo-scope-nonce": tooShort, "x-demo-cache-control": "no-store" }),
            ),
        ).toBeUndefined();
        expect(
            behaviourFromHeaders(
                headers({
                    "x-demo-scope-nonce": "n".repeat(SCOPE_NONCE_MIN_LENGTH),
                    "x-demo-cache-control": "no-store",
                }),
            ),
        ).toBeDefined();
    });

    it("refuses a nonce longer than the ceiling, so this cannot reflect arbitrary text", () => {
        expect(
            behaviourFromHeaders(
                headers({
                    "x-demo-scope-nonce": "n".repeat(SCOPE_NONCE_MAX_LENGTH + 1),
                    "x-demo-cache-control": "no-store",
                }),
            ),
        ).toBeUndefined();
    });

    it("discards the whole request when a header value could break the response apart", () => {
        // A newline in a header value ends the header and starts one the caller wrote. It is
        // rejected rather than stripped, because a caller who sent one is asking for something this
        // origin will not do, and a sanitized version of it is not what they asked for.
        //
        // Over the record shape rather than `Headers`, because the `Headers` constructor refuses
        // these values itself. The record is what `src/node.ts` hands over, and a runtime that lets
        // the bytes through is the one this check has to hold on.
        const values = [
            "a\nb",
            "a\rb",
            `a${String.fromCharCode(0)}b`,
            "x".repeat(HEADER_VALUE_MAX_LENGTH + 1),
        ];
        for (const value of values) {
            expect(
                behaviourFromHeaders({
                    "x-demo-scope-nonce": NONCE,
                    "x-demo-set-cookie": value,
                }),
                `value ${JSON.stringify(value)} must not be accepted`,
            ).toBeUndefined();
        }
    });

    it("refuses a delay beyond the ceiling, or one that is not a count of milliseconds", () => {
        // The ceiling sits just above the 30 second first-byte timeout of the highest paid plan:
        // high enough to outlast it, low enough that nothing waits for an answer that can no longer
        // arrive inside the edge's own 120 second budget.
        for (const value of [String(DELAY_MAX_MS + 1), "-1", "1.5", "soon"]) {
            expect(
                behaviourFromHeaders(
                    headers({ "x-demo-scope-nonce": NONCE, "x-demo-delay-ms": value }),
                ),
                `delay ${value} must not be accepted`,
            ).toBeUndefined();
        }
        expect(
            behaviourFromHeaders(
                headers({ "x-demo-scope-nonce": NONCE, "x-demo-delay-ms": String(DELAY_MAX_MS) }),
            ),
        ).toEqual({ nonce: NONCE, delayMs: DELAY_MAX_MS });
    });

    it("refuses an echo list that is not a list of header names", () => {
        for (const value of [
            "a b",
            "x".repeat(ECHO_NAME_MAX_LENGTH + 1),
            Array.from({ length: ECHO_NAMES_MAX + 1 }, (_, index) => `h${index}`).join(","),
        ]) {
            expect(
                behaviourFromHeaders(
                    headers({ "x-demo-scope-nonce": NONCE, "x-demo-echo-headers": value }),
                ),
                `echo list ${value} must not be accepted`,
            ).toBeUndefined();
        }
    });

    it("lowercases the echo list, because a header lookup is case insensitive and a key is not", () => {
        expect(
            behaviourFromHeaders(
                headers({
                    "x-demo-scope-nonce": NONCE,
                    "x-demo-echo-headers": "Authorization, Cookie",
                }),
            ),
        ).toEqual({ nonce: NONCE, delayMs: 0, echo: ["authorization", "cookie"] });
    });
});

describe("the scoping rule", () => {
    it("holds when the nonce travels beside the field that owns its own cache key", () => {
        expect(isInScope(NONCE, scopedBody())).toBe(true);
    });

    it("fails when the document is one other callers share", () => {
        // The case this whole rule exists for. `{ products }` is keyed on the document alone, so a
        // stored response built from a lever would be handed to everybody asking the same question,
        // and no later request could dislodge it.
        const shared = JSON.stringify({ query: "{ products { id name } }" });
        expect(isInScope(NONCE, shared)).toBe(false);
    });

    it("fails when a shared document merely mentions the nonce", () => {
        const searched = JSON.stringify({
            query: "query S($t: String!) { search(term: $t) { id } }",
            variables: { t: NONCE },
        });
        expect(isInScope(NONCE, searched)).toBe(false);
    });

    it("fails when a faulty query carries somebody else's nonce", () => {
        expect(isInScope(NONCE, scopedBody("another-nonce"))).toBe(false);
    });

    it("accepts the nonce inline in the document, not only in the variables", () => {
        // Both spellings address the same key, and a reader writing a curl by hand writes the
        // inline one. Requiring variables would make the lever silently inert for them.
        expect(isInScope(NONCE, `{"query":"{ faulty(nonce: \\"${NONCE}\\") { nonce } }"}`)).toBe(
            true,
        );
    });

    it("applies nothing at all to an out of scope request, rather than half of it", () => {
        // Not "the headers but not the delay". A partially applied lever is a response nobody asked
        // for and nobody can explain from the request in front of them.
        const asked = headers({
            "x-demo-scope-nonce": NONCE,
            "x-demo-cache-control": "max-age=31536000",
            "x-demo-delay-ms": "5000",
        });
        expect(
            scopedBehaviour(asked, JSON.stringify({ query: "{ products { id } }" })),
        ).toBeUndefined();
        expect(scopedBehaviour(asked, scopedBody())).toEqual({
            nonce: NONCE,
            cacheControl: "max-age=31536000",
            delayMs: 5000,
        });
    });
});

describe("the response headers a behaviour adds", () => {
    it("adds nothing when nothing was asked for", () => {
        expect(behaviourHeaders(undefined, headers({}))).toEqual({});
    });

    it("sets exactly the three values, unnormalized", () => {
        // Unnormalized on purpose: the subject is an origin sending something questionable, so a
        // demo that tidied the value up would be demonstrating the tidy version.
        expect(
            behaviourHeaders(
                {
                    nonce: NONCE,
                    cacheControl: "MAX-AGE=60,   public",
                    setCookie: "sid=abc",
                    surrogateKey: "k1 k2",
                    delayMs: 0,
                },
                headers({}),
            ),
        ).toEqual({
            "cache-control": "MAX-AGE=60,   public",
            "set-cookie": "sid=abc",
            "surrogate-key": "k1 k2",
        });
    });
});

describe("the echo", () => {
    function echoed(received: Headers, echo: string[] | "*"): Record<string, string | null> {
        const value = behaviourHeaders({ nonce: NONCE, delayMs: 0, echo }, received)[
            ECHO_RESPONSE_HEADER
        ];
        return JSON.parse(value ?? "{}");
    }

    it("reports a named header that did not arrive as null", () => {
        // The property the whole echo exists for. "The edge stripped it" is only provable against
        // an echo that can say a header was absent; one that omitted empty values would leave a
        // test unable to tell a stripped header from an echo that did not run.
        expect(echoed(headers({ "x-kept": "yes" }), ["x-kept", "x-gone"])).toEqual({
            "x-kept": "yes",
            "x-gone": null,
        });
    });

    it("names a credential header without repeating its value", () => {
        // The echo can end up in a response the edge stores. "Did my token reach the origin" stays
        // answerable; "what is it" does not.
        expect(
            echoed(headers({ authorization: "Bearer secret-token" }), ["authorization"]),
        ).toEqual({ authorization: "<redacted>" });
    });

    it("reports every header that arrived when asked for the lot", () => {
        const all = echoed(headers({ "x-b": "2", "x-a": "1" }), "*");
        expect(all["x-a"]).toBe("1");
        expect(all["x-b"]).toBe("2");
        // Sorted, so two runs of one request produce the same bytes and a diff is a real change.
        expect(Object.keys(all)).toEqual([...Object.keys(all)].sort());
    });

    it("says how many entries it dropped rather than quietly shortening the list", () => {
        // A silently truncated echo reads exactly like a header that never arrived, which is the
        // one conclusion this feature must never let a test draw by accident.
        const many = new Headers();
        for (let index = 0; index < 60; index += 1) {
            many.set(`x-filler-${String(index).padStart(3, "0")}`, "v".repeat(120));
        }
        const all = echoed(many, "*");

        expect(Number(all["x-demo-echo-dropped"])).toBeGreaterThan(0);
        expect(
            (
                behaviourHeaders({ nonce: NONCE, delayMs: 0, echo: "*" }, many)[
                    ECHO_RESPONSE_HEADER
                ] ?? ""
            ).length,
        ).toBeLessThanOrEqual(ECHO_MAX_BYTES);
    });
});
