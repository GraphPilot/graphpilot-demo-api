# A response of an exact size

**What this shows:** how big a response is, as the billing counts it. GraphPilot bills one request
unit per started 10 KiB (10,240 bytes) of the uncompressed response body, headers excluded, and a
request that goes on to the shield counts twice. The boundary is a single byte wide, so a demo of
it needs an answer whose size can be chosen to the byte.

`Query.sized(bytes:)` is that answer. It pads a string so the **whole JSON body** the origin sends
is exactly `bytes` long, envelope included. The field carries
`@cacheControl(maxAge: 3600, scope: PUBLIC)` and the static key `sized`, so the second request is
a HIT and a purge of `sized` clears every entry.

## Send this

```sh
for bytes in 10240 10241 25600; do
  curl -sS "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"query Sized { sized(bytes: $bytes) }\"}" \
    -o /dev/null -w "$bytes -> %{size_download} bytes\n"
done
```

## What comes back

```
10240 -> 10240 bytes
10241 -> 10241 bytes
25600 -> 25600 bytes
```

The body is `{"data":{"sized":"0123456789abcdef..."}}` and nothing else. The units these bodies
cost are 1, 2 and 3 per hop.

Add `--compressed` and curl asks for gzip. `%{size_download}` then shows what crossed the wire,
about 200 bytes for the 25,600-byte answer, because the padding repeats one short alphabet. The
billed size does not change: it is the uncompressed body.

## The rules that keep the size exact

- **`sized` must be the only selection in the operation.** A second field, `__typename` or a
  fragment adds bytes the resolver cannot count, so the request is answered with the error
  `DEMO_SIZED_INVALID` instead of a size that is not the one asked for. An alias is fine: the
  envelope is computed from the response key you chose.
- **Between the envelope and 1 MiB.** Below the envelope (21 bytes under the key `sized`) there is
  no string short enough; above 1 MiB a public demo has no reason to answer.
- **`nonce` only changes the cache key.** `sized(bytes: 10240, nonce: "run-1")` is its own entry,
  so a run can start from a MISS, and its body is byte for byte the body without a nonce.

## Which header proves it

None does. Size is a property of the body: `curl -w '%{size_download}'` without `--compressed`
measures it, and the request's row in GraphPilot's telemetry records it as the response body
bytes. `gp-cache` still tells you which hop answered, which is the other half of what a request
costs.
