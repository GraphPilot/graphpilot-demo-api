import { describe, expect, it } from "vitest";
import { readSignatureHeaders } from "../signing/headers.ts";
import {
    buildCanonicalString,
    SKEW_SECONDS,
    signCanonicalString,
    verifyOriginSignature,
} from "../signing/verify.ts";

// The vector published in the request-signing docs and pinned by the proxy in
// `gp-proxy/src/config/deployment/signing_key_impl.rs`. If it fails, the demo no longer verifies
// what the edge produces.
const KEY = "gpsk_test_key";
const BODY = '{"query":"{ me { id } }"}';
const BODY_HASH = "64d4ae404c393f3916a308845f1df6e2ccd4243d889d3883f9b2dd7da9d31114";
const CANONICAL = `POST\n/graphql?op=ping\n1718700000\n${BODY_HASH}`;
const SIGNATURE = "708YYmz8ifG4D6z8Fl1XVh1oIDtn8NFRhNkTZPR+ZWM=";
const TIMESTAMP = 1_718_700_000;

const PARTS = { method: "POST", pathAndQuery: "/graphql?op=ping", body: BODY };

/** Both spellings, so a test can say which pair it sent. */
function headers(pairs: Record<string, string>): Headers {
    return new Headers(pairs);
}

function signedHeaders(signature = SIGNATURE, timestamp = TIMESTAMP): Headers {
    return headers({ "gp-signature": `v1=${signature}`, "gp-timestamp": String(timestamp) });
}

describe("the canonical string", () => {
    it("has the documented shape", async () => {
        expect(await buildCanonicalString(PARTS, TIMESTAMP)).toBe(CANONICAL);
    });

    it("hashes an empty body as the empty string", async () => {
        const canonical = await buildCanonicalString(
            { method: "GET", pathAndQuery: "/", body: "" },
            TIMESTAMP,
        );

        expect(canonical).toBe(
            "GET\n/\n1718700000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    });

    it("uppercases the method", async () => {
        const canonical = await buildCanonicalString({ ...PARTS, method: "post" }, TIMESTAMP);

        expect(canonical.split("\n")[0]).toBe("POST");
    });

    it("covers the query string, so a signature cannot be replayed at another target", async () => {
        const withQuery = await buildCanonicalString(PARTS, TIMESTAMP);
        const withoutQuery = await buildCanonicalString(
            { ...PARTS, pathAndQuery: "/graphql" },
            TIMESTAMP,
        );

        expect(withQuery).not.toBe(withoutQuery);
    });
});

describe("signing", () => {
    it("reproduces the documented test vector", async () => {
        expect(await signCanonicalString(KEY, CANONICAL)).toBe(SIGNATURE);
    });

    it("produces a different signature under a different key", async () => {
        expect(await signCanonicalString("gpsk_other", CANONICAL)).not.toBe(SIGNATURE);
    });
});

describe("header reading", () => {
    it("accepts the gp- spelling", () => {
        const found = readSignatureHeaders(signedHeaders());

        expect(found).toEqual({ signature: `v1=${SIGNATURE}`, timestamp: String(TIMESTAMP) });
    });

    // TODO(signing): drop this case with the old pair, once the proxy rename is everywhere.
    it("accepts the graphpilot- spelling", () => {
        const found = readSignatureHeaders(
            headers({
                "graphpilot-signature": `v1=${SIGNATURE}`,
                "graphpilot-timestamp": String(TIMESTAMP),
            }),
        );

        expect(found).toEqual({ signature: `v1=${SIGNATURE}`, timestamp: String(TIMESTAMP) });
    });

    it("prefers the new spelling when both are present", () => {
        const found = readSignatureHeaders(
            headers({
                "gp-signature": "v1=new",
                "gp-timestamp": "2",
                "graphpilot-signature": "v1=old",
                "graphpilot-timestamp": "1",
            }),
        );

        expect(found).toEqual({ signature: "v1=new", timestamp: "2" });
    });

    it("reads a plain node header record too", () => {
        const found = readSignatureHeaders({ "gp-signature": "v1=x", "gp-timestamp": "2" });

        expect(found).toEqual({ signature: "v1=x", timestamp: "2" });
    });

    it("finds nothing when only one of the pair is present", () => {
        expect(readSignatureHeaders(headers({ "gp-signature": "v1=x" }))).toBeNull();
    });
});

describe("verification", () => {
    it("accepts a request the edge really signed", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(), {
            key: KEY,
            now: TIMESTAMP + 5,
        });

        expect(result.ok).toBe(true);
    });

    it("accepts the old header spelling", async () => {
        const result = await verifyOriginSignature(
            PARTS,
            headers({
                "graphpilot-signature": `v1=${SIGNATURE}`,
                "graphpilot-timestamp": String(TIMESTAMP),
            }),
            { key: KEY, now: TIMESTAMP },
        );

        expect(result.ok).toBe(true);
    });

    it("refuses a request with no signature at all", async () => {
        const result = await verifyOriginSignature(PARTS, headers({}), {
            key: KEY,
            now: TIMESTAMP,
        });

        expect(result).toMatchObject({ ok: false, reason: "missing" });
    });

    it("refuses a signature header with no version prefix", async () => {
        const result = await verifyOriginSignature(
            PARTS,
            headers({ "gp-signature": SIGNATURE, "gp-timestamp": String(TIMESTAMP) }),
            { key: KEY, now: TIMESTAMP },
        );

        expect(result).toMatchObject({ ok: false, reason: "malformed" });
    });

    it("refuses a scheme version it does not know", async () => {
        const result = await verifyOriginSignature(
            PARTS,
            headers({ "gp-signature": `v2=${SIGNATURE}`, "gp-timestamp": String(TIMESTAMP) }),
            { key: KEY, now: TIMESTAMP },
        );

        expect(result).toMatchObject({ ok: false, reason: "unsupported-version" });
    });

    it("refuses a timestamp that is not a number", async () => {
        const result = await verifyOriginSignature(
            PARTS,
            headers({ "gp-signature": `v1=${SIGNATURE}`, "gp-timestamp": "yesterday" }),
            { key: KEY, now: TIMESTAMP },
        );

        expect(result).toMatchObject({ ok: false, reason: "malformed" });
    });

    it("refuses a signature that is not base64", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders("not base64!!"), {
            key: KEY,
            now: TIMESTAMP,
        });

        expect(result).toMatchObject({ ok: false, reason: "malformed" });
    });

    it("refuses a signature made for another body", async () => {
        const result = await verifyOriginSignature(
            { ...PARTS, body: '{"query":"{ now }"}' },
            signedHeaders(),
            { key: KEY, now: TIMESTAMP },
        );

        expect(result).toMatchObject({ ok: false, reason: "mismatch" });
    });

    it("refuses a signature made with another key", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(), {
            key: "gpsk_someone_else",
            now: TIMESTAMP,
        });

        expect(result).toMatchObject({ ok: false, reason: "mismatch" });
    });

    it("refuses a replay from outside the skew window", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(), {
            key: KEY,
            now: TIMESTAMP + SKEW_SECONDS + 1,
        });

        expect(result).toMatchObject({ ok: false, reason: "stale" });
    });

    it("refuses a timestamp too far in the future", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(), {
            key: KEY,
            now: TIMESTAMP - SKEW_SECONDS - 1,
        });

        expect(result).toMatchObject({ ok: false, reason: "stale" });
    });

    it("accepts a timestamp at the edge of the window", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(), {
            key: KEY,
            now: TIMESTAMP + SKEW_SECONDS,
        });

        expect(result.ok).toBe(true);
    });

    it("checks the timestamp against the signature, so a shifted one cannot slip through", async () => {
        const result = await verifyOriginSignature(PARTS, signedHeaders(SIGNATURE, TIMESTAMP + 1), {
            key: KEY,
            now: TIMESTAMP,
        });

        expect(result).toMatchObject({ ok: false, reason: "mismatch" });
    });
});
