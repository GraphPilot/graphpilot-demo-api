/**
 * A response of an exact size, asked for by number.
 *
 * GraphPilot bills a request by the size of its response body: one unit per started 10 KiB of the
 * uncompressed body, headers excluded. The interesting cases sit on the boundary (10,240 bytes is
 * one unit, 10,241 is two), and no answer in the catalogue can be steered onto a byte. This one
 * can: `Query.sized(bytes:)` pads its string so the WHOLE JSON body the origin sends is exactly
 * `bytes` long, which is the number the edge records as `response_body_bytes`.
 *
 * The whole body, not the field, because the body is what is billed. The envelope around the
 * string (`{"data":{"sized":"` and `"}}`) is subtracted here, using the response key the client
 * actually chose, so an alias keeps the total exact.
 *
 * Two things would break that arithmetic, and both are refused rather than answered wrong:
 *
 *   1. Anything else in the operation. A second root field, `__typename` or a fragment adds bytes
 *      this resolver cannot see, so `sized` answers only when it is the operation's one selection.
 *   2. A character JSON escapes, or one that is more than one byte in UTF-8. The padding is printable
 *      ASCII without `"` or `\`, so one character is one byte on the wire.
 *
 * The padding repeats a short alphabet. That is deliberate: it compresses well, so a gzip copy of
 * the same answer is visibly smaller than the body, which is the comparison a test of "billing reads
 * the uncompressed size" needs to make.
 */

import { GraphQLError } from "graphql";

/** The largest body that may be asked for. The billing cases need tens of kilobytes; the demo
 * origin's own ceiling is far above this, and a public endpoint has no reason to hand out more. */
export const SIZED_MAX_BYTES = 1_048_576;

/** Printable ASCII, none of it escaped by JSON: one character is one byte of the body. */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

/** The bytes around the padding in `{"data":{"<key>":"<padding>"}}`, for one response key. */
export function envelopeBytes(responseKey: string): number {
    return JSON.stringify({ data: { [responseKey]: "" } }).length;
}

function invalid(message: string): GraphQLError {
    return new GraphQLError(message, { extensions: { code: "DEMO_SIZED_INVALID" } });
}

/**
 * The string that makes the body exactly `bytes` long under `responseKey`.
 *
 * `selections` is how many selections the operation's root carries; anything but one means the
 * body holds bytes this function did not count, and it refuses rather than answering a size that
 * is not the one asked for.
 */
export function paddingFor(bytes: number, responseKey: string, selections: number): string {
    if (selections !== 1) {
        throw invalid(
            "Query.sized must be the only selection in the operation: anything beside it adds " +
                "bytes to the body, and the body would no longer be the size asked for",
        );
    }
    const envelope = envelopeBytes(responseKey);
    if (!Number.isInteger(bytes) || bytes < envelope || bytes > SIZED_MAX_BYTES) {
        throw invalid(
            `Query.sized(bytes:) must be between ${envelope} (the envelope under the key ` +
                `"${responseKey}") and ${SIZED_MAX_BYTES}, got ${bytes}`,
        );
    }
    const length = bytes - envelope;
    return ALPHABET.repeat(Math.ceil(length / ALPHABET.length)).slice(0, length);
}
