/**
 * The badly behaved origin, requested by header.
 *
 * `src/fault.ts` covers the origin that does not answer. This covers the origin that answers, and
 * answers with something the edge has to make a decision about: a `Cache-Control` of its own, a
 * `Set-Cookie`, a `Surrogate-Key` it invented, or nothing at all for longer than the edge is willing
 * to wait. Every one of those is a promise GraphPilot makes ("a response carrying `Set-Cookie` is
 * not stored", "the origin's own `Cache-Control` is read"), and none of them could be watched
 * against this demo before, because the demo origin is well behaved by construction.
 *
 * It also answers the question a test asks more often than any other: which of my headers actually
 * reached the origin. That one is an echo rather than a misbehaviour, and it lives here because it
 * is bound by the same scoping rule and would otherwise leak one caller's headers into another
 * caller's cache entry.
 *
 * ## Why a header and not an argument
 *
 * Same reason `src/fault.ts` gives. `x-demo-delay-ms` has to be honoured before the first byte,
 * which is before Yoga has parsed anything, and `x-demo-cache-control` acts on the HTTP response
 * rather than on the GraphQL body, which no resolver owns. GraphPilot forwards every header it does
 * not own, so `x-demo-*` arrives exactly as the client sent it.
 *
 * ## The scoping rule, which is the whole safety argument
 *
 * The cache key is the document plus its variables. It does NOT include request headers. So a lever
 * applied to a response the edge then stores is written into an entry that every other caller
 * sending that same document reads: one `x-demo-cache-control: max-age=31536000` on `{ products }`
 * would hand a year-old catalogue to everybody, and no second request could dislodge it.
 *
 * The guard is therefore not "is a lever requested" but "is this request addressing a cache key
 * nobody else is using". `Query.faulty(nonce:)` is exactly that: `nonce` is required, it is the
 * caller's own value, and it travels in the document's variables, so it is part of the key. A
 * request that carries a fresh nonce through `faulty` owns its entry outright.
 *
 * So the levers apply only when both hold:
 *
 *   1. `x-demo-scope-nonce` names a nonce of at least {@link SCOPE_NONCE_MIN_LENGTH} characters, and
 *   2. the request body contains that nonce literally, beside the word `faulty`.
 *
 * The body is checked as text rather than parsed, and that is deliberate on both halves. The nonce
 * may arrive inline in the document or in `variables`, and a parse would have to cover both and
 * would have to happen before the delay, on every request, including the ones that ask for nothing.
 * Text containment is the weaker check in theory and the exact one in practice: if the nonce appears
 * anywhere in the body, the body differs from every body that does not contain it, and two different
 * bodies cannot share a cache key. Requiring `faulty` beside it then keeps the blast radius on the
 * one field whose contract already says "this entry is yours".
 *
 * What it does not defend against, and cannot: a caller who reuses a nonce somebody else is using,
 * or publishes theirs. That is the same limit `x-demo-fail-nonce` has, and the answer is the same
 * one: make the nonce unique per run, which is what every docs page does with `$(date +%s)`.
 *
 * An unscoped request is answered normally, with no lever applied at all. Half-applying (the headers
 * but not the delay, say) would produce a response nobody asked for and nobody can explain, and
 * refusing outright would answer 400 to a reader who mistyped a header, which is the trap
 * `src/fault.ts` already declines to set.
 */

import { type HeaderSource, readHeader } from "./signing/headers.ts";

/** Names the cache entry the levers are confined to. Required; nothing applies without it. */
const SCOPE_HEADER = "x-demo-scope-nonce";

/** The `Cache-Control` the origin should put on its response, verbatim. */
const CACHE_CONTROL_HEADER = "x-demo-cache-control";
/** The `Set-Cookie` the origin should put on its response, verbatim. */
const SET_COOKIE_HEADER = "x-demo-set-cookie";
/** The `Surrogate-Key` the origin should put on its response, verbatim. */
const SURROGATE_KEY_HEADER = "x-demo-surrogate-key";
/** How long to wait before answering at all. */
const DELAY_HEADER = "x-demo-delay-ms";
/** Which request headers to echo back, comma separated, or `*` for every one that arrived. */
const ECHO_HEADER = "x-demo-echo-headers";

/** Where the echo lands. JSON, so absence is expressible and a test does not have to parse prose. */
export const ECHO_RESPONSE_HEADER = "x-demo-received-headers";

/**
 * The shortest nonce accepted.
 *
 * The scoping argument rests entirely on the nonce being one nobody else is sending, and `1` is not
 * such a nonce. Eight characters is not a proof of uniqueness either, but it is the length below
 * which a collision stops being bad luck and becomes the expected case.
 */
export const SCOPE_NONCE_MIN_LENGTH = 8;

/** The longest nonce accepted, matching `src/fault.ts`, so a public endpoint cannot be used to
 * store or reflect arbitrary text. */
export const SCOPE_NONCE_MAX_LENGTH = 128;

/** The longest value any of the three header levers may set. Long enough for a real
 * `Cache-Control` or a cookie with attributes, short enough that the response stays a response. */
export const HEADER_VALUE_MAX_LENGTH = 256;

/**
 * The longest delay that may be asked for.
 *
 * The useful case is a delay that OUTLASTS the edge's first-byte timeout, because that is the one
 * that shows what a customer's clients see when an origin stalls. That ceiling is 5000 ms on the
 * free plan and 30000 ms on every paid one, so the cap has to sit above 30000 to stay useful, and
 * should sit barely above it: three attempts at 35 seconds already spend more than the 120 seconds
 * a request may hold at the edge, and nothing is learned by waiting longer than that.
 */
export const DELAY_MAX_MS = 35_000;

/** The most header names one request may ask to have echoed. */
export const ECHO_NAMES_MAX = 20;

/** The longest header name accepted in the echo list. */
export const ECHO_NAME_MAX_LENGTH = 64;

/** The size the echo is truncated to, so one request cannot be answered with a response whose
 * headers dwarf its body. */
export const ECHO_MAX_BYTES = 4_096;

/**
 * Headers whose presence is worth proving and whose value is not worth leaking.
 *
 * The echo may be written into a response the edge stores, and `authorization` is a bearer token.
 * Echoing the name with a placeholder keeps every question a test actually asks answerable ("did my
 * token reach the origin", "was the cookie stripped") and answers none of the ones an attacker asks.
 */
const REDACTED = new Set([
    "authorization",
    "cookie",
    "gp-signature",
    "graphpilot-signature",
    "x-admin-token",
]);

/** What a redacted value reads as. Chosen to be obviously not a value. */
const REDACTION = "<redacted>";

/** Printable ASCII only, which is what a header value may legally carry. Rejecting the rest is
 * what keeps `x-demo-set-cookie` from being a header injection: a CR or LF here would end the
 * header and start another one the caller wrote. */
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;

/** A header name as RFC 9110 spells one. The echo list is turned into lookups, so anything that is
 * not a name is a typo and the whole request is read as asking for no echo. */
const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

/** The field the scope nonce has to be sitting next to. See the scoping rule above. */
const SCOPED_FIELD = "faulty";

/** Either every header that arrived, or the named ones. The distinction survives into the echo,
 * because only the named form can report a header as absent. */
export type EchoSelection = "*" | string[];

export interface OriginBehaviour {
    /** The nonce the levers are scoped to. */
    nonce: string;
    cacheControl?: string;
    setCookie?: string;
    surrogateKey?: string;
    /** Milliseconds to wait before the first byte. Zero when none was asked for. */
    delayMs: number;
    echo?: EchoSelection;
}

/**
 * What the request asked the origin to do badly, or undefined when it asked for nothing.
 *
 * Malformed input is read as "not requested" rather than refused, for the reason `src/fault.ts`
 * gives: a demo that answers 400 to a mistyped header is a trap, and a silently absent lever is
 * visible immediately, because the response simply looks ordinary.
 *
 * This does not decide whether the levers APPLY. That is {@link isInScope}, which needs the body.
 */
export function behaviourFromHeaders(headers: HeaderSource): OriginBehaviour | undefined {
    const nonce = readHeader(headers, SCOPE_HEADER)?.trim();
    if (!nonce || nonce.length < SCOPE_NONCE_MIN_LENGTH || nonce.length > SCOPE_NONCE_MAX_LENGTH) {
        return undefined;
    }

    const cacheControl = headerValue(headers, CACHE_CONTROL_HEADER);
    const setCookie = headerValue(headers, SET_COOKIE_HEADER);
    const surrogateKey = headerValue(headers, SURROGATE_KEY_HEADER);
    if (cacheControl === null || setCookie === null || surrogateKey === null) {
        return undefined;
    }

    const delayMs = delayValue(readHeader(headers, DELAY_HEADER));
    if (delayMs === null) {
        return undefined;
    }

    const echo = echoValue(readHeader(headers, ECHO_HEADER));
    if (echo === null) {
        return undefined;
    }

    // A nonce and nothing else is not a request for anything. Saying so here keeps the caller from
    // having to distinguish "scoped, no levers" from "no levers" downstream.
    if (!cacheControl && !setCookie && !surrogateKey && delayMs === 0 && !echo) {
        return undefined;
    }

    return {
        nonce,
        ...(cacheControl ? { cacheControl } : {}),
        ...(setCookie ? { setCookie } : {}),
        ...(surrogateKey ? { surrogateKey } : {}),
        delayMs,
        ...(echo ? { echo } : {}),
    };
}

/**
 * Whether this body is the one request the levers may act on.
 *
 * Both halves matter. The nonce proves the cache key is this caller's own; `faulty` proves the key
 * belongs to the field that was built to be owned by one caller. A body that has one without the
 * other is somebody's shared document and gets the ordinary answer.
 */
export function isInScope(nonce: string, body: string): boolean {
    return body.includes(nonce) && body.includes(SCOPED_FIELD);
}

/** The behaviour this request may actually have, which is the parsed one only when the body puts it
 * in scope. One call rather than two, because forgetting the second is the mistake that turns this
 * file into a cache poisoning endpoint. */
export function scopedBehaviour(headers: HeaderSource, body: string): OriginBehaviour | undefined {
    const behaviour = behaviourFromHeaders(headers);
    if (!behaviour || !isInScope(behaviour.nonce, body)) {
        return undefined;
    }
    return behaviour;
}

/** Waits, and nothing else. Separate so both entry points spend the delay identically and a test
 * can assert on the number without spending it. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The response headers a scoped behaviour adds, as one record both entry points write.
 *
 * `Cache-Control`, `Set-Cookie` and `Surrogate-Key` are set to exactly what was asked for, which is
 * the point: the demo is the origin misbehaving, so the values are not normalized, deduplicated or
 * merged with anything the framework would have sent.
 */
export function behaviourHeaders(
    behaviour: OriginBehaviour | undefined,
    received: HeaderSource,
): Record<string, string> {
    if (!behaviour) {
        return {};
    }
    const headers: Record<string, string> = {};
    if (behaviour.cacheControl) {
        headers["cache-control"] = behaviour.cacheControl;
    }
    if (behaviour.setCookie) {
        headers["set-cookie"] = behaviour.setCookie;
    }
    if (behaviour.surrogateKey) {
        headers["surrogate-key"] = behaviour.surrogateKey;
    }
    if (behaviour.echo) {
        headers[ECHO_RESPONSE_HEADER] = echoOf(received, behaviour.echo);
    }
    return headers;
}

/**
 * The echo, as JSON.
 *
 * A named list reports `null` for a header that did not arrive, and that is the form worth using: a
 * test about the edge stripping something can only be written against an echo that can say "this
 * was not here". `*` reports what arrived and cannot express absence, so it is for finding out what
 * the edge adds rather than for asserting on what it removes.
 *
 * Values are the first one where a header arrived more than once, which is what
 * {@link readHeader} hands back on both runtimes.
 */
export function echoOf(received: HeaderSource, selection: EchoSelection): string {
    const echoed: Record<string, string | null> = {};

    if (selection === "*") {
        let dropped = 0;
        // Sorted, so two runs of the same request produce the same bytes and a diff is a real
        // difference rather than an iteration order.
        for (const [name, value] of allHeaders(received)) {
            if (JSON.stringify(echoed).length + name.length + value.length + 8 > ECHO_MAX_BYTES) {
                dropped += 1;
                continue;
            }
            echoed[name] = display(name, value);
        }
        if (dropped > 0) {
            // Named rather than silently short. An echo that quietly omits entries is worse than no
            // echo, because a test reads the omission as an absent header.
            echoed["x-demo-echo-dropped"] = String(dropped);
        }
        return JSON.stringify(echoed);
    }

    for (const name of selection) {
        const value = readHeader(received, name);
        echoed[name] = value === null ? null : display(name, value);
    }
    return JSON.stringify(echoed);
}

/** One echoed value: the real one, or the placeholder for the headers that carry credentials. */
function display(name: string, value: string): string {
    if (REDACTED.has(name)) {
        return REDACTION;
    }
    return value.length > HEADER_VALUE_MAX_LENGTH
        ? `${value.slice(0, HEADER_VALUE_MAX_LENGTH)}…`
        : value;
}

/** Every header that arrived, lowercased and sorted, over both header shapes. */
function allHeaders(received: HeaderSource): [string, string][] {
    const entries: [string, string][] =
        received instanceof Headers
            ? [...received.entries()]
            : Object.entries(received).flatMap(([name, value]) => {
                  if (value === undefined) {
                      return [];
                  }
                  const first = Array.isArray(value) ? value[0] : value;
                  return first === undefined ? [] : [[name, first] as [string, string]];
              });
    return entries
        .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * One header lever's value: the string, `undefined` when it was not asked for, `null` when it is
 * not something that may be put on a response.
 *
 * The three states are the reason this returns what it does. An absent lever and a malformed one
 * are different: the first leaves the rest of the request standing, the second discards the whole
 * behaviour, because a caller who sent a newline in a cookie is not going to be served a partial
 * version of what they asked for.
 */
function headerValue(headers: HeaderSource, name: string): string | undefined | null {
    const raw = readHeader(headers, name);
    if (raw === null || raw.trim() === "") {
        return undefined;
    }
    const value = raw.trim();
    if (value.length > HEADER_VALUE_MAX_LENGTH || !HEADER_VALUE_PATTERN.test(value)) {
        return null;
    }
    return value;
}

/** The delay in milliseconds, `0` when none was asked for, `null` when the value is junk or beyond
 * the ceiling. */
function delayValue(raw: string | null): number | null {
    if (raw === null || raw.trim() === "") {
        return 0;
    }
    const value = raw.trim();
    // Digits and nothing else, rather than `parseInt` alone: `parseInt("1.5")` is `1`, and a caller
    // who asked for 1.5 milliseconds has misunderstood something that a silently rounded answer
    // would not tell them.
    if (!/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed > DELAY_MAX_MS) {
        return null;
    }
    return parsed;
}

/** The echo selection, `undefined` when none was asked for, `null` when the list is not a list of
 * header names. */
function echoValue(raw: string | null): EchoSelection | undefined | null {
    if (raw === null || raw.trim() === "") {
        return undefined;
    }
    const value = raw.trim();
    if (value === "*") {
        return "*";
    }
    const names = value
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");
    if (names.length === 0 || names.length > ECHO_NAMES_MAX) {
        return null;
    }
    for (const name of names) {
        if (name.length > ECHO_NAME_MAX_LENGTH || !HEADER_NAME_PATTERN.test(name)) {
            return null;
        }
    }
    return names;
}
