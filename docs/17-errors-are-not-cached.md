# Errors are not cached

**What this shows:** the one rule in the whole caching decision with no opt-in anywhere. A response
carrying a GraphQL `errors` array is never stored, even when everything else about it says it could
be, and even when most of the answer resolved perfectly well.

The reason is worth stating before the curl. An errored response describes the moment it was
produced, not the data. Storing it would serve that one failure to everyone who asked the same
question, until the entry expired. A five minute entry built from a ten second outage keeps
answering with the outage for four minutes and fifty seconds after it is over.

`Query.faulty` exists for this page. It carries `@cacheControl(maxAge: 300, scope: PUBLIC)` through
`type Fault`, so it is an answer the edge would happily store, and that is the point: "it was not
cached" proves nothing about an operation that was never cacheable in the first place.

## The control, first

```sh
NONCE="n-$(date +%s)"

curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d "{\"query\":\"query Control(\$n: String!) { faulty(nonce: \$n) { nonce observedAt } }\",\"variables\":{\"n\":\"$NONCE\"}}" \
  | grep -iE '^gp-cache'
```

```
gp-cache: MISS
```

Stored, like any other answer. Ask it again within five minutes and it is a `HIT`. Everything below
differs from this by one thing only.

## Errors, and nothing else

`fail: true` makes the resolver itself throw. `faulty` is `Fault!`, so there is no nullable position
for the error to stop at and the whole `data` is nulled.

```sh
curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d "{\"query\":\"query Failing(\$n: String!) { faulty(nonce: \$n, fail: true) { nonce } }\",\"variables\":{\"n\":\"$NONCE-fail\"}}" \
  | grep -iE '^gp-cache|errors'
```

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS
{"errors":[{"message":"Query.faulty was asked to fail ...","path":["faulty"]}],"data":null}
```

Send it twice. It is `PASS` both times, which is the part that matters: a single `PASS` would only
say this answer was not stored, not that no entry exists. The repeat is what proves there is nothing
to find.

## Errors beside data, which is the interesting one

`Fault.broken` throws whenever it is selected, and it is nullable, so the error stops there instead
of climbing. The fields next to it resolve normally.

```sh
curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d "{\"query\":\"query Partial(\$n: String!) { faulty(nonce: \$n) { nonce observedAt broken } }\",\"variables\":{\"n\":\"$NONCE-partial\"}}" \
  | grep -iE '^gp-cache|"nonce"'
```

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS
{"errors":[{"message":"Fault.broken always fails ...","path":["faulty","broken"]}],"data":{"faulty":{"nonce":"...","observedAt":"...","broken":null}}}
```

A 200, real data the client can use, and still nothing stored. This is the case where the rule
actually costs something, and it is still the right call: the half that failed is the half a later
caller would be served without ever having asked for it.

## Why it is not the status rule

A `4xx` or `5xx` response is also not stored by default, and that is a *different* rule with a
different code and a promised opt-in. The `errors` array rule is GraphQL-only, is evaluated in step
one of the write decision ahead of both policy sources, and has no opt-in at all. A response can be
a perfectly ordinary `200` and still land here, which is exactly what the two commands above do.

## What proves it

`gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS` on a response whose control answered `MISS`. The
control is not decoration: without it, `PASS` is equally consistent with an operation that has no
cache policy, which is a completely different finding.
