# A misbehaving origin

**What this shows:** how to make this origin answer badly on purpose, so the edge's answer to a bad
origin can be watched instead of assumed, and how one request does that without touching anybody
else's cache entry.

Every page before this one has a well behaved origin: it answers quickly, sends no `Cache-Control`
of its own, sets no cookie, and invents no keys. That is what makes the pages readable, and it also
means the rules about an origin that does none of those things had nothing to demonstrate them. A
`Set-Cookie` stops a response being stored; an origin `Cache-Control` decides the lifetime; a
`Surrogate-Key` from the origin is added to the ones GraphPilot derives; an origin that stalls past
the first-byte timeout becomes a `502`. Four promises, and no way to see any of them hold.

## The headers

| Header | Accepted values | What it does |
| --- | --- | --- |
| `x-demo-scope-nonce` | 8 to 128 characters, required | Names the cache entry the levers are confined to. Nothing below applies without it. |
| `x-demo-cache-control` | up to 256 printable ASCII characters | The origin sets exactly this `Cache-Control` on its response. |
| `x-demo-set-cookie` | up to 256 printable ASCII characters | The origin sets exactly this `Set-Cookie`. |
| `x-demo-surrogate-key` | up to 256 printable ASCII characters | The origin sets exactly this `Surrogate-Key`. |
| `x-demo-delay-ms` | `0` to `35000` | The origin waits this long before its first byte. |
| `x-demo-echo-headers` | up to 20 header names, comma separated, or `*` | The origin reports which of those headers reached it, in `x-demo-received-headers`. |

Anything outside those bounds, and anything malformed, is read as "no lever requested" rather than
refused, the same way `x-demo-fail-*` is on the previous page: a demo that answers `400` to a
mistyped header is a trap. A value carrying a newline is discarded for a second reason as well,
since honouring it would let a caller write a header of their own onto the response.

## The rule that makes this safe

**The cache key is the document plus its variables. It does not include request headers.** So a
lever honoured on a shared document would be written into the entry everybody sending that document
reads, and no later request could dislodge it. `x-demo-cache-control: public, max-age=31536000` on
`{ products }` would hand a year-old catalogue to every caller of this demo.

The levers therefore apply only when **the request body contains the scope nonce, beside `faulty`**.
`Query.faulty(nonce:)` takes a required nonce, the nonce travels in the variables, and the variables
are in the key, so a request with a fresh nonce owns its entry outright and cannot reach anyone
else's. A request that fails either half is answered normally with **no lever applied at all**, not
with some of them.

What that does not cover, and cannot: a nonce two callers both use. Generate a fresh one per run,
which is what every command below does.

## Set the lifetime from the origin

`type Fault` carries `@cacheControl(maxAge: 300)`, so the control answer lives five minutes. The
origin's own header decides instead:

```sh
N="lever-$(date +%s)"

for i in 1 2; do
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -H "x-demo-scope-nonce: $N" \
    -H 'x-demo-cache-control: max-age=30' \
    -d "{\"query\":\"query L(\$n: String!) { faulty(nonce: \$n) { nonce observedAt } }\",\"variables\":{\"n\":\"$N\"}}" \
    | grep -iE '^cache-control|^gp-cache'
done
```

```
cache-control: max-age=30
gp-cache: MISS

cache-control: max-age=30
gp-cache: HIT
gp-cache-hits: 1
gp-cache-max-age: 30
gp-cache-age: 0
gp-cache-remaining: 30
```

Thirty, not the schema's three hundred: `gp-cache-max-age` is the lifetime the entry was actually
stored with. Send `x-demo-cache-control: no-store` instead and nothing is stored at all:

```
cache-control: no-store
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_NO_STORE
```

## Set a cookie, and watch the answer stop being stored

```sh
N="lever-$(date +%s)"

curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-scope-nonce: $N" \
  -H 'x-demo-set-cookie: sid=abc123; Path=/; HttpOnly' \
  -d "{\"query\":\"query L(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
  | grep -iE '^set-cookie|^gp-cache'
```

```
set-cookie: sid=abc123; Path=/; HttpOnly
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_SET_COOKIE
```

The cookie reaches the client untouched, and the response is not stored. That is the whole point of
the rule: a cookie is by definition for one caller, and an entry built from one would hand that
caller's session to the next person asking the same question.

## Invent a surrogate key

```sh
-H 'x-demo-surrogate-key: invented-by-the-origin'
```

```
gp-surrogate-key: ck:81b222ae… ck:81b222ae…:7e7a1f05fdb89ef q:faulty Fault Query fault invented-by-the-origin
```

The origin's key is **added** to the ones GraphPilot derived, not substituted for them. The entry is
stored (`gp-cache: MISS`, then `HIT` on a repeat) and is purgeable under either kind of key.

## Prove which headers reached the origin

```sh
N="lever-$(date +%s)"
TOKEN=$(curl -sS "$ORIGIN/auth/token" -H 'content-type: application/json' \
  -d '{"sub":"user-ada","org":"org-acme","role":"admin"}' | jq -r .token)

curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "authorization: Bearer $TOKEN" \
  -H 'cookie: sid=fromclient' \
  -H "x-demo-scope-nonce: $N" \
  -H 'x-demo-echo-headers: authorization,cookie,gp-client-name,x-gp-organization,x-gp-role' \
  -d "{\"query\":\"query L(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
  | grep -i '^x-demo-received-headers'
```

```
x-demo-received-headers: {"authorization":"<redacted>","cookie":"<redacted>","gp-client-name":null,"x-gp-organization":null,"x-gp-role":null}
```

Four facts in one line, and three of them are absences:

- the bearer token and the client's cookie **did** reach the origin, which is why this origin has to
  verify the token itself,
- `gp-client-name` did **not**: it is inside the reserved `gp-` prefix, the edge reads it for the
  `[[client.profile]]` in `gpilot.toml` and does not forward it,
- neither did `x-gp-organization` or `x-gp-role`, the two bucket headers `[[cache.policy.vary]]`
  derives. They key the entry at the edge and stay there, because both entries leave
  `pass_to_origin` at its default of `never`.

A named header that did not arrive is reported as `null`, which is what makes the second and third
bullets provable at all. `authorization` and `cookie` are reported by name with their value replaced,
because the echo can end up in a response the edge stores and a bearer token is not something to
write into a cache.

Ask for `*` instead of a list and the answer is everything that arrived, which is how to find out
what the edge and Cloudflare **add**:

```
x-demo-received-headers: {"accept":"*/*","accept-encoding":"gzip, br","cf-connecting-ip":"…","cf-ipcountry":"NL","cf-ray":"…","cf-visitor":"{\"scheme\":\"https\"}","connection":"Keep-Alive","content-length":"137","content-type":"application/json","gp-signature":"<redacted>","gp-timestamp":"1790592894","host":"graphpilot-demo-api.graphpilot.workers.dev","user-agent":"curl/8.7.1","x-demo-echo-headers":"*","x-demo-scope-nonce":"…","x-forwarded-proto":"https","x-real-ip":"…"}
```

`*` cannot say a header was absent, only that it is not in the list, so use the named form for any
assertion about something being stripped.

## Stall, and watch the first-byte timeout

This is the lever with the most surprising measured behaviour, and the numbers below are this
service's, not a general rule: the demo is on the free plan, where `[origin] first_byte_timeout_ms`
is capped at 5000, and `gpilot.toml` turns retries on with `max_retries = 2`.

```sh
N="lever-$(date +%s)"

time curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-scope-nonce: $N" \
  -H 'x-demo-delay-ms: 5000' \
  -d "{\"query\":\"query L(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
  | grep -iE '^HTTP|^gp-|^cache-control'
```

```
HTTP/2 502
cache-control: no-store

real    0m15.55s
```

Measured, one millisecond either side of the budget:

| `x-demo-delay-ms` | What the client got | After |
| --- | --- | --- |
| 2000 | `200`, `gp-cache: MISS` | 2.19 s |
| 4000 | `200`, `gp-cache: MISS` | 4.15 s |
| 4900 | `200`, `gp-cache: MISS` | 5.03 s |
| 5000 | `502`, `BAD_GATEWAY` | 15.55 s |
| 12000 | `502`, `BAD_GATEWAY` | 15.62 s |
| 35000 | `502`, `BAD_GATEWAY` | 15.59 s |

**The fifteen seconds are the retries.** A delay at or past the five second budget times out, the
timeout is retried, and each retry stalls for exactly as long, so the client waits three attempts
(plus the short fixed backoff) before being told. That is why every delay from 5000 upwards costs
the same 15.5 seconds: the ceiling is the timeout, not the delay, and asking for 35 seconds buys
nothing that asking for 5 does not. It is also why the `502` carries no `gp-origin-retries`: the
header rides on the answer, and here there was never an answer to put it on.

Combine the delay with the previous page's refusal and the arithmetic is visible:

```sh
-H 'x-demo-delay-ms: 2000' -H "x-demo-fail-nonce: $N" -H 'x-demo-fail-times: 1'
```

```
HTTP/2 200
gp-cache: MISS
gp-origin-retries: 1

real    0m4.44s
```

Two attempts, each of them delayed, and the client is told nothing except by the retry count. A test
measuring latency against a retrying service is measuring `attempts x delay`, never the delay.

## Out of scope, and nothing happens

The same levers on a document other callers share:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-scope-nonce: lever-$(date +%s)" \
  -H 'x-demo-cache-control: public, max-age=31536000' \
  -H 'x-demo-set-cookie: sid=poison' \
  -d '{"query":"query Shared { categories { id name } }"}' \
  | grep -iE '^HTTP|^cache-control|^set-cookie|^gp-cache'
```

```
HTTP/2 200
gp-cache: MISS
```

No `cache-control`, no `set-cookie`, an ordinary answer. The same happens when the nonce is in the
headers but not in the body, which is the accident worth knowing about: change the nonce in your
`variables` and forget the header, and every lever goes quiet rather than landing on the wrong entry.

## What proves it

Each claim has its own header, and none of them is the response body:

- `gp-cache-max-age` for the lifetime the origin's `Cache-Control` set,
- `gp-cache-reason: CACHE_SKIPPED_SET_COOKIE` and `CACHE_SKIPPED_NO_STORE` for the two responses
  that were not stored,
- `gp-surrogate-key` for the origin's own key sitting beside the derived ones,
- `x-demo-received-headers` for what reached the origin, with `null` for what did not,
- the `502` with no `gp-cache` header at all for the stall, and `gp-origin-retries` on the answer
  that survived one.
