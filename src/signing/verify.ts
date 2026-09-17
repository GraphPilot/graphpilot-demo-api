import { type HeaderSource, readSignatureHeaders } from "./headers.ts";

/**
 * Verification of the signature the GraphPilot edge puts on every request it forwards.
 *
 * The scheme is copied from the proxy, not invented here:
 *
 *     canonical = METHOD \n path?query \n unix_seconds \n sha256_hex(body)
 *     signature = base64(HMAC-SHA256(key, canonical))
 *     header    = v1=<signature>
 *
 * The key is the raw key string used as HMAC key material, with no base64 or hex transform.
 */

/** The version prefix on the header value. The scheme can evolve without breaking old verifiers. */
export const SIGNATURE_VERSION = "v1";

/** How far the timestamp may be from our own clock, in either direction. */
export const SKEW_SECONDS = 300;

/** Why a request was refused. The caller logs it; the client is only told that it was refused. */
export type RejectionReason =
    | "missing"
    | "malformed"
    | "unsupported-version"
    | "stale"
    | "mismatch";

export interface SignedRequestParts {
    method: string;
    /** Path and query exactly as it arrived, query string included. */
    pathAndQuery: string;
    /** The raw body bytes, as received. An empty string for a request with no body. */
    body: string | Uint8Array;
}

export interface VerificationOptions {
    key: string;
    /** Unix seconds. Injectable so a test can pin the clock. */
    now?: number;
    skewSeconds?: number;
}

export type VerificationResult =
    | { ok: true }
    | { ok: false; reason: RejectionReason; message: string };

const encoder = new TextEncoder();

function refuse(reason: RejectionReason, message: string): VerificationResult {
    return { ok: false, reason, message };
}

/** Lowercase hex of SHA-256, the spelling the canonical string asks for. */
async function hexSha256(body: string | Uint8Array): Promise<string> {
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function buildCanonicalString(
    parts: SignedRequestParts,
    timestamp: number,
): Promise<string> {
    const bodyHash = await hexSha256(parts.body);
    return `${parts.method.toUpperCase()}\n${parts.pathAndQuery}\n${timestamp}\n${bodyHash}`;
}

async function importKey(key: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
    try {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    } catch {
        return null;
    }
}

/** The signature for a canonical string, without the version prefix. Exported so the tests can
 * pin the published vector and so a local script can sign a request by hand. */
export async function signCanonicalString(key: string, canonical: string): Promise<string> {
    const signature = await crypto.subtle.sign(
        "HMAC",
        await importKey(key),
        encoder.encode(canonical),
    );
    return toBase64(new Uint8Array(signature));
}

/**
 * Compare in constant time. A byte-wise early return leaks how many leading bytes were right,
 * which is enough to forge a signature one byte at a time.
 */
function equalInConstantTime(left: Uint8Array, right: Uint8Array): boolean {
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    return difference === 0;
}

export async function verifyOriginSignature(
    parts: SignedRequestParts,
    headers: HeaderSource,
    options: VerificationOptions,
): Promise<VerificationResult> {
    const found = readSignatureHeaders(headers);
    if (!found) {
        return refuse("missing", "no signature headers on the request");
    }

    // A base64 signature can end in `=` padding, so the prefix is recognized by its shape rather
    // than by the first `=` in the value.
    const separator = found.signature.indexOf("=");
    const version = separator > 0 ? found.signature.slice(0, separator) : "";
    if (!/^v\d+$/.test(version)) {
        return refuse("malformed", "the signature header carries no version prefix");
    }
    if (version !== SIGNATURE_VERSION) {
        return refuse("unsupported-version", `unknown signature scheme ${version}`);
    }

    const provided = fromBase64(found.signature.slice(separator + 1));
    if (!provided) {
        return refuse("malformed", "the signature is not base64");
    }

    const timestamp = Number(found.timestamp);
    if (!Number.isInteger(timestamp)) {
        return refuse("malformed", "the timestamp is not a whole number of seconds");
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const skew = options.skewSeconds ?? SKEW_SECONDS;
    if (Math.abs(now - timestamp) > skew) {
        return refuse("stale", `the timestamp is outside the ${skew}s window`);
    }

    const canonical = await buildCanonicalString(parts, timestamp);
    const expected = fromBase64(await signCanonicalString(options.key, canonical));
    if (!expected || !equalInConstantTime(provided, expected)) {
        return refuse("mismatch", "the signature does not match this request");
    }

    return { ok: true };
}
