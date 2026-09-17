import { SignJWT } from "jose";
import { AUDIENCE, ISSUER } from "./claims.ts";
import { ALGORITHM, type DemoKeys } from "./keys.ts";

/**
 * `POST /auth/token`. A demo mints a token for whoever asks: there is nothing to authenticate
 * against, and the point is to let a reader hold two identities at once and watch the edge keep
 * their cached answers apart. No real API does this.
 */

export const TOKEN_TTL_SECONDS = 3600;

export interface TokenRequest {
    sub: string;
    org: string;
    role: string;
}

export interface MintedToken {
    token: string;
    expiresIn: number;
}

/** What an entry point turns into an HTTP answer. Kept transport-free so Node and Workers share it. */
export interface EndpointReply {
    status: number;
    body: unknown;
}

function parseTokenRequest(rawBody: string): TokenRequest | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const { sub, org, role } = parsed as Record<string, unknown>;
    if (typeof sub !== "string" || typeof org !== "string" || typeof role !== "string") {
        return null;
    }
    if (!sub || !org || !role) {
        return null;
    }
    return { sub, org, role };
}

export async function mintToken(
    keys: DemoKeys,
    request: TokenRequest,
    ttlSeconds = TOKEN_TTL_SECONDS,
): Promise<MintedToken> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ org_id: request.org, role: request.role })
        .setProtectedHeader({ alg: ALGORITHM, kid: keys.kid })
        .setSubject(request.sub)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(keys.privateKey);

    return { token, expiresIn: ttlSeconds };
}

export async function handleTokenRequest(rawBody: string, keys: DemoKeys): Promise<EndpointReply> {
    const request = parseTokenRequest(rawBody);
    if (!request) {
        return {
            status: 400,
            body: { error: "send a JSON body with the three strings sub, org and role" },
        };
    }
    return { status: 200, body: await mintToken(keys, request) };
}
