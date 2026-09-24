# Origin retries

**What this shows:** a request that failed on its way to the origin, sent again, without the client
ever learning that the first attempt failed.

Retries are off by default everywhere, because retrying changes what an origin sees and no service
should start receiving a failed request twice because GraphPilot was upgraded. This demo switches
them on, in `gpilot.toml`:

```toml
[origin.retry]
enabled = true
max_retries = 2
```

## Asking the origin to fail

The demo origin refuses the first N attempts of a run and answers the one after. Three headers
control it, and they travel to the origin untouched because GraphPilot forwards every header it does
not own:

| Header | Default | What it does |
| --- | --- | --- |
| `x-demo-fail-nonce` | none, and required | Names the run. Refusals are counted per nonce, so one caller's failure never reaches another's request. |
| `x-demo-fail-times` | `1` | How many attempts to refuse, at most 5. |
| `x-demo-fail-status` | `503` | Which status to refuse with. Only `502`, `503` and `504` are accepted, because those are the three `[origin.retry]` treats as retryable out of the box. |

A nonce is required rather than optional for a reason worth reading twice: a retry replays the
request byte for byte, so the two attempts are identical and the origin can only tell them apart by
remembering that it already refused one. The nonce is what it remembers against.

## Send this

```sh
NONCE="retry-$(date +%s)"

curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-fail-nonce: $NONCE" \
  -H 'x-demo-fail-times: 1' \
  -d "{\"query\":\"query Retried(\$n: String!) { faulty(nonce: \$n) { nonce observedAt } }\",\"variables\":{\"n\":\"$NONCE\"}}" \
  | grep -iE '^gp-cache|^gp-origin-retries|"nonce"'
```

## What comes back

```
gp-cache: MISS
gp-origin-retries: 1
```

with the answer in the body. The client got a `200` and a usable answer; the first attempt failed
and it never found out. `gp-origin-retries` is the only evidence, and it is absent entirely when
there were no retries, so compare against a run without the headers.

Ask for more failures than the configuration allows retries and the client sees the failure instead:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-fail-nonce: $NONCE-exhausted" \
  -H 'x-demo-fail-times: 5' \
  -d "{\"query\":\"query Exhausted(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$NONCE-exhausted\"}}" \
  | grep -iE '^HTTP|^gp-'
```

```
HTTP/2 503
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_ERROR_STATUS
gp-origin-retries: 2
```

Three attempts, the first plus the two retries, all refused, and the client is told. Whatever the
retries cost, nobody waits forever: the count is a hard ceiling.

Note the status: the client gets the origin's own `503`, not a `502`. `BAD_GATEWAY` is for an
origin that could not be reached or did not answer usably. This origin answered, it just answered
with a refusal, and GraphPilot passes that through rather than rewriting it.

And note `gp-cache: PASS` with `gp-cache-reason: CACHE_SKIPPED_ERROR_STATUS`. An error status is
not stored, so the next caller asking the same question reaches your origin rather than being
handed your outage. That is the default since graphpilot-proxy#474; a service that wants a
particular status cached, a `404` for a resource that genuinely does not exist for example, lists
it in `cache.policy.store_error_statuses`.

Worth knowing why this rule exists separately from the one on the previous page. A `5xx` carries no
`errors` array, so the GraphQL rule never sees it, and until this landed the response was stored
under the schema's own lifetime and served as a `HIT` to everyone sharing the key. A ten second
outage became a five minute one.

## What is worth knowing beyond the curl

**A retry happens below the cache.** A cache hit never retries, because it never reaches the origin
at all. A background revalidation inside the stale window is an ordinary origin request and retries
like any other.

**Mutations are retried by default.** The three retryable statuses all mean the request never
reached the application, so the mutation never ran and sending it again is the first write rather
than a second one. That holds exactly as far as an origin's status codes do. An origin that can
return a gateway status *after* a write has already committed, a proxy timing out mid-commit for
example, wants `retry_mutations = false`.

**The delay is spent waiting.** `backoff` and `delay_ms` cost wall clock on the client's request,
and they count against the 120 second budget a request may spend at the edge. A configuration whose
worst case does not fit is refused when the deployment is built, rather than discovered in
production.

## What proves it

`gp-origin-retries` on the response, and its absence on the same request sent without the headers.
No `[response]` switch can suppress it, so it is there whenever a retry happened.
