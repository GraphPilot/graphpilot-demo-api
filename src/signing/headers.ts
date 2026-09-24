/**
 * The header pair the proxy adds to every request it forwards to an origin. It is a published
 * contract, not something derived from the service configuration.
 */

/** The current spelling, since the proxy renamed everything it sends into the `gp-` namespace. */
export const SIGNATURE_HEADER = "gp-signature";
export const TIMESTAMP_HEADER = "gp-timestamp";

// TODO(signing): drop this pair once the proxy rename (branch `signing-header-gp`) has reached
// every deployment. Until then an origin has to read both, because it cannot know which side of
// the rename the request in front of it came from.
export const LEGACY_SIGNATURE_HEADER = "graphpilot-signature";
export const LEGACY_TIMESTAMP_HEADER = "graphpilot-timestamp";

/** Everything this module needs of a request's headers, so it works over `Headers` and over the
 * plain lowercase record a Node server hands out. */
export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export interface SignatureHeaders {
    signature: string;
    timestamp: string;
}

/** One header off either shape, or null when it is absent. Exported because `HeaderSource` is
 * the repository's answer to "this runs on Node and on Workers", and anything else reading a
 * request header needs the same two-shape lookup rather than a second copy of it. */
export function readHeader(source: HeaderSource, name: string): string | null {
    if (source instanceof Headers) {
        return source.get(name);
    }
    const value = source[name];
    if (value === undefined) {
        return null;
    }
    return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Both names of the pair, or null when neither spelling carries both halves. The new spelling
 * wins where both are present, so a proxy that sends both is read as the new one.
 */
export function readSignatureHeaders(source: HeaderSource): SignatureHeaders | null {
    for (const [signatureName, timestampName] of [
        [SIGNATURE_HEADER, TIMESTAMP_HEADER],
        [LEGACY_SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER],
    ] as const) {
        const signature = readHeader(source, signatureName);
        const timestamp = readHeader(source, timestampName);
        if (signature !== null && timestamp !== null) {
            return { signature, timestamp };
        }
    }
    return null;
}
