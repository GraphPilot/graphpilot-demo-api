# Origin signature

**What this shows:** the recommended way to protect an origin that sits behind GraphPilot. The
edge signs every request it forwards; the origin verifies the signature and answers 401 to anything
else, before a resolver runs.

Without it, a public origin URL is a way around the edge: no cache, no client profiles, no
document limits, no rate limiting, and an origin absorbing traffic it was meant to be shielded
from. A signature is what makes the edge the only door.

The scheme is copied from the proxy rather than invented, because a demo people copy from has to
be the real thing. `src/signing/` implements it:

- Canonical string, newline separated: the uppercase method, the path with its query string, the
  unix timestamp, and the lowercase hex SHA-256 of the body.
- Signature: base64 of `HMAC-SHA256(signing_key, canonical)`, compared in constant time.
- Header value: `v1=<signature>`, beside the timestamp.
- Skew window: 300 seconds either side, so a replayed request expires.

The key is the service's own signing key, issued by GraphPilot. It is never in this repository.

## Which paths it covers

`/graphql`, and deliberately nothing else. The other routes cannot be signed, and saying why is
half the lesson:

| Path | Signed | Why |
| --- | --- | --- |
| `/graphql` | yes | the API surface, and the only thing worth shielding |
| `/auth/jwks.json` | no | GraphPilot fetches the key set itself, at deploy time. That is not a proxied request, so there is no signature on it and requiring one would make the service undeployable. A public key is public anyway. |
| `/auth/token` | no | a demo affordance, reachable by anyone, because a reader needs a token before they have anything to send through the edge |
| `/health` | no | probed by things that hold no key |
| `/admin/reset` | yes, on the Worker | guarded by the signature where signatures are on, and by `x-admin-token` where they are off, so it is never simply open |

An origin in production would have far fewer unsigned paths than this, because it would not be
minting tokens for strangers. `/auth/jwks.json` and `/health` are the two that stay unsigned in any
real setup.

## Send this

Through the edge, which signs:

```sh
curl -sS -o/dev/null -w '%{http_code}\n' "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query Ping { now }"}'
```

Straight at the origin, which does not:

```sh
curl -sS -o/dev/null -w '%{http_code}\n' "$ORIGIN/graphql" \
  -H 'content-type: application/json' \
  -d '{"query":"query Ping { now }"}'
```

And, for the contrast, an unsigned path on the same origin:

```sh
curl -sS -o/dev/null -w '%{http_code}\n' "$ORIGIN/auth/jwks.json"
```

## What comes back

```
200
401
200
```

The 401 is the whole feature. The 200 underneath it is the reminder that the guard is per path:
the key set has to stay reachable or GraphPilot cannot deploy the service at all.

The 401 body says only that this origin answers signed requests. Which check failed is logged and
never returned, because telling a caller which part of its forgery was wrong is telling it how to
fix the forgery.

## Which header proves it

Not a response header this time, but a request one, and its absence: `graphpilot-signature` (with
`graphpilot-timestamp` beside it) is on the request the edge forwards and on nothing you send by
hand. The status code is the evidence: 200 through the edge, 401 around it, on the same path.

## Notes

- The demo currently accepts both `graphpilot-signature`/`graphpilot-timestamp` and
  `gp-signature`/`gp-timestamp`. A rename is in flight on the proxy side, and an origin that
  accepted only one spelling would break on whichever day the other one shipped. The old spelling
  goes once the rename has landed everywhere.
- It fails closed. No signature, a bad signature, or a stale timestamp is a 401 and no resolver
  runs. There is no "warn and continue" mode, because a verification you do not act on is not a
  verification.
- `REQUIRE_SIGNATURE=false` turns it off for a local run with no proxy in front, and logs a warning
  on every request while it is off. Do not set it anywhere real.
- A replay is refused by the skew window rather than by remembering signatures: five minutes after
  it was minted, a captured signature is worthless.
