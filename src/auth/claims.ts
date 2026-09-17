import { jwtVerify } from "jose";
import type { DemoKeys } from "./keys.ts";

/** Who the caller is. These three names are the ones the edge's bucket configuration derives its
 * vary headers from, so they are a contract, not an implementation detail. */
export interface Claims {
    sub: string;
    org_id: string;
    role: string;
}

/** The demo is its own issuer and its own audience: there is no identity provider behind it. */
export const ISSUER = "graphpilot-demo-api";
export const AUDIENCE = "graphpilot-demo-api";

/** A token that was presented and did not verify. Distinct from no token at all: a caller who
 * sends nothing is anonymous, a caller who sends a bad token is refused. */
export class InvalidTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTokenError";
    }
}

const BEARER = /^Bearer (.+)$/;

function isClaims(payload: Record<string, unknown>): payload is Record<string, unknown> & Claims {
    return (
        typeof payload.sub === "string" &&
        typeof payload.org_id === "string" &&
        typeof payload.role === "string"
    );
}

/** The claims a token carries, verified against our own public key. */
export async function verifyToken(token: string, keys: DemoKeys): Promise<Claims> {
    let payload: Record<string, unknown>;
    try {
        ({ payload } = await jwtVerify(token, keys.publicKey, {
            issuer: ISSUER,
            audience: AUDIENCE,
            algorithms: ["RS256"],
        }));
    } catch (error) {
        throw new InvalidTokenError(error instanceof Error ? error.message : "token rejected");
    }

    if (!isClaims(payload)) {
        throw new InvalidTokenError("the token is missing one of sub, org_id, role");
    }
    return { sub: payload.sub, org_id: payload.org_id, role: payload.role };
}

/**
 * Null when nobody claimed an identity, the verified claims when somebody did. Throws when a
 * token was presented and did not hold up, so an entry point can answer 401 rather than quietly
 * serving the anonymous answer to someone who believes they are signed in.
 */
export async function claimsFromAuthorization(
    authorization: string | undefined | null,
    keys: DemoKeys,
): Promise<Claims | null> {
    if (!authorization) {
        return null;
    }
    const match = BEARER.exec(authorization);
    if (!match?.[1]) {
        throw new InvalidTokenError("the authorization header is not a bearer token");
    }
    return verifyToken(match[1], keys);
}
