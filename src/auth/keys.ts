import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

/**
 * The RS256 key pair the demo signs its own tokens with, and the public half it publishes at
 * `/auth/jwks.json` for the edge to fetch.
 */

export const ALGORITHM = "RS256";

export interface DemoKeys {
    /** Names the key in the token header, so a fetched set with several keys still verifies. */
    kid: string;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    /** The private half, in the shape configuration carries it. Never published. */
    privateJwk: JWK;
    /** The public half, ready to go into the key set. */
    publicJwk: JWK;
}

async function keysFromPair(privateKey: CryptoKey, publicKey: CryptoKey): Promise<DemoKeys> {
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    // The thumbprint is derived from the public key itself, so the same pair always gets the same
    // kid. A random one would change on every restart even when the key did not.
    const kid = await calculateJwkThumbprint(publicJwk);
    return {
        kid,
        privateKey,
        publicKey,
        privateJwk: { ...privateJwk, kid, alg: ALGORITHM },
        publicJwk: { ...publicJwk, kid, alg: ALGORITHM, use: "sig" },
    };
}

/** A fresh pair. Fine for development, wrong for production: see `loadKeys`. */
export async function generateKeys(): Promise<DemoKeys> {
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    return keysFromPair(privateKey, publicKey);
}

/** The pair a deployment was configured with. The public half is derived from the private one, so
 * configuration carries a single value. */
export async function keysFromPrivateJwk(jwk: JWK | string): Promise<DemoKeys> {
    const parsed: JWK = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
    const privateKey = (await importJWK({ ...parsed, alg: ALGORITHM }, ALGORITHM, {
        extractable: true,
    })) as CryptoKey;
    // A public JWK is the private one without its secret parameters.
    const { d, p, q, dp, dq, qi, ...publicParts } = parsed;
    const publicKey = (await importJWK({ ...publicParts, alg: ALGORITHM }, ALGORITHM)) as CryptoKey;
    return keysFromPair(privateKey, publicKey);
}

export interface KeyConfiguration {
    /** A private RSA JWK as JSON. In production it comes from the environment. */
    privateJwk?: string | undefined;
}

/**
 * Generating at startup is convenient locally and wrong once anyone holds a token: a restart
 * would invalidate every token already minted, because the new pair verifies none of them. So a
 * deployment configures the pair, and a missing one is an announced fallback, not a default.
 */
export async function loadKeys(configuration: KeyConfiguration): Promise<DemoKeys> {
    if (configuration.privateJwk) {
        return keysFromPrivateJwk(configuration.privateJwk);
    }
    console.warn(
        "no AUTH_PRIVATE_JWK configured: generating a key pair, so every restart invalidates the tokens minted before it",
    );
    return generateKeys();
}
