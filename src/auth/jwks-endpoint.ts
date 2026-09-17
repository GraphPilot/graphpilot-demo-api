import type { DemoKeys } from "./keys.ts";
import type { EndpointReply } from "./token-endpoint.ts";

/**
 * `GET /auth/jwks.json`. The edge fetches this to verify the tokens this demo mints, which is how
 * a JWT provider in `gpilot.toml` is pointed at the demo's own keys.
 */
export function handleJwksRequest(keys: DemoKeys): EndpointReply {
    // Only the public half, and only the fields a verifier needs. `keys.privateJwk` never leaves
    // the process.
    return { status: 200, body: { keys: [keys.publicJwk] } };
}
