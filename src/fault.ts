/**
 * The transient origin failure, requested by header.
 *
 * `Query.faulty` in the schema covers what the edge does when the origin ANSWERS badly. This covers
 * what it does when the origin does not answer at all, which is a different promise with a
 * different observable: an origin that refuses with a gateway status is retried when
 * `[origin.retry]` is configured, and the response that eventually succeeds carries
 * `gp-origin-retries`. Without a way to fail exactly once, there is nothing to count.
 *
 * ## Why a header and not an argument
 *
 * A retry replays the request byte for byte, so the origin cannot tell the second attempt from the
 * first by looking at it. The failure therefore has to be decided before the body is parsed, and by
 * something that survives the edge unchanged. GraphPilot forwards every header it does not own, so
 * `x-demo-fail-*` arrives exactly as the client sent it. A GraphQL argument would arrive too, but
 * only after Yoga has run, which is after the point where a gateway status has to be returned.
 *
 * ## Why this is safe on a public demo
 *
 * The failure is scoped to whoever asks for it. The nonce is the caller's own value and is counted
 * on its own row, so one caller's requested failure never reaches another's request. The limits
 * below bound what a caller can ask for: at most five refusals, a nonce no longer than a URL
 * fragment, and a row that is forgotten after ten minutes. And the whole path sits behind the origin
 * signature guard, so only a request GraphPilot signed can reach it at all.
 */

import { type HeaderSource, readHeader } from "./signing/headers.ts";
import { FAULT_NONCE_MAX_LENGTH, FAULT_TIMES_MAX } from "./store/port.ts";

/** The header naming the run, and the key the refusals are counted under. */
const NONCE_HEADER = "x-demo-fail-nonce";
/** How many attempts to refuse before answering normally. */
const TIMES_HEADER = "x-demo-fail-times";
/** Which status to refuse with. Defaults to 503, one of the three the proxy retries by default. */
const STATUS_HEADER = "x-demo-fail-status";

/** The three gateway statuses `[origin.retry]` treats as retryable out of the box. A `500` is
 * deliberately not among them: that is an application answering, and answering twice is rarely what
 * a client wants. Restricting the header to these keeps the demo from teaching otherwise. */
const RETRYABLE = new Set([502, 503, 504]);

const DEFAULT_STATUS = 503;
const DEFAULT_TIMES = 1;

export interface FaultRequest {
    nonce: string;
    times: number;
    status: number;
}

/**
 * What the request asked to have fail, or undefined when it asked for nothing.
 *
 * A malformed value is read as "no fault requested" rather than refused. The alternative is a demo
 * that answers 400 to a header a reader mistyped, which turns a teaching aid into a trap; and a
 * silent absence is visible immediately, because the request simply succeeds.
 */
export function faultFromHeaders(headers: HeaderSource): FaultRequest | undefined {
    const nonce = readHeader(headers, NONCE_HEADER)?.trim();
    if (!nonce || nonce.length > FAULT_NONCE_MAX_LENGTH) {
        return undefined;
    }

    const times = clampedInteger(
        readHeader(headers, TIMES_HEADER),
        DEFAULT_TIMES,
        1,
        FAULT_TIMES_MAX,
    );
    if (times === undefined) {
        return undefined;
    }

    const requested = readHeader(headers, STATUS_HEADER)?.trim();
    const status = requested ? Number.parseInt(requested, 10) : DEFAULT_STATUS;
    if (!RETRYABLE.has(status)) {
        return undefined;
    }

    return { nonce, times, status };
}

/** A whole number within bounds, the fallback when the header is absent, undefined when it is junk. */
function clampedInteger(
    raw: string | null,
    fallback: number,
    min: number,
    max: number,
): number | undefined {
    if (raw === null || raw.trim() === "") {
        return fallback;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        return undefined;
    }
    return parsed;
}
