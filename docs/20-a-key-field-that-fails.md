# A key field that fails

**What this shows:** the edge asking the origin for a field the client did not select, because it
needs that field's value to tag the entry, and what reaches the client when resolving it goes wrong.

Every page up to here has one selection set: the one the client wrote. That is not what the origin
sees. A `@surrogateKey(of: "<field>")` key is built from a value, so the edge adds that field to the
query it forwards, under an alias of its own, and removes it from the answer before the client sees
it. Nothing about it is visible in the request or the response body. The only evidence is the key on
the entry, and a failure.

`type KeyedFault` exists for this page. It is `type Fault` with one difference:

```graphql
type KeyedFault
    @cacheControl(maxAge: 300, scope: PUBLIC)
    @surrogateKey(of: "brokenId")
    @surrogateKey(static: "fault") {
    nonce: String!
    observedAt: String!
    brokenId: ID
}
```

`brokenId` resolves to `keyed-<nonce>`, or throws when the query asks it to with
`keyedFault(failKey: true)`.

## The injection, first

Select `nonce` and nothing else:

```sh
N="kf-$(date +%s)"

curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d "{\"query\":\"query Injected(\$n: String!) { keyedFault(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
  | grep -iE '^gp-cache|^gp-surrogate-key|"nonce"'
```

```
gp-cache: MISS
gp-surrogate-key: ck:835bf141… ck:835bf141…:11f3085f16fc7d24 q:keyedFault KeyedFault Query fault KeyedFault:brokenId:keyed-kf-1790594142
{"data":{"keyedFault":{"nonce":"kf-1790594142"}}}
```

`KeyedFault:brokenId:keyed-kf-1790594142` is on the entry, and the body contains no `brokenId`. The
origin ran a field the client never wrote and the client never learned it existed. Send it again and
it is an ordinary `HIT`, with the same keys:

```
gp-cache: HIT
gp-cache-hits: 1
gp-cache-max-age: 300
gp-cache-age: 3
```

That is the control, and it matters for the same reason the control on `docs/17` does: what follows
differs from it by one argument.

## Now make the injected field throw

```sh
curl -sS -D- "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d "{\"query\":\"query InjectedFailing(\$n: String!) { keyedFault(nonce: \$n, failKey: true) { nonce } }\",\"variables\":{\"n\":\"$N-fail\"}}" \
  | grep -iE '^gp-cache|^gp-surrogate-key|errors|"nonce"'
```

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS
gp-surrogate-key: ck:4aa5e6fa… ck:4aa5e6fa…:ccd17c059e6b4908 q:keyedFault KeyedFault Query fault KeyedFault:brokenId:
{"data":{"keyedFault":{"nonce":"kf-1790594142-fail"}}}
```

Three things happened, and each is worth naming.

**The error is gone.** The origin answered with an `errors` array whose one entry has the path
`["keyedFault", "brokenId"]`. The client's document has no `brokenId` in it, so an error about it
would be unanswerable: there is nothing in the query it could point at. The edge removes the entry
along with the field it injected, and the client gets clean data. That is error stripping, and this
is the only query in the demo that reaches it.

**It is still not stored.** `CACHE_SKIPPED_GRAPHQL_ERRORS`, on both sends, exactly as on `docs/17`.
The rule is evaluated against what the ORIGIN returned, not against the tidied answer the client
receives, and that is the conservative order: the response was produced by a run that partly failed,
whatever the client can see of it.

**The key degrades to an empty value.** `KeyedFault:brokenId:` with nothing after it, because the
field the key is built from resolved to null. Nothing was stored here, so nothing is tagged with it;
but a response that failed a key field and WAS stored would carry a key no purge could be written
against. An origin whose key fields can fail is an origin whose invalidation can quietly stop
working, which is the practical warning on this page.

## The quiet one: a key field that is simply null

The failure above is loud. It produces an `errors` array, and that array is what stops the response
being stored, so the empty key it produced was never written onto an entry anybody can hit. The case
that costs a customer something is the same null without the error, and it is not a fault at all: a
nullable key field that legitimately has no value. An optional author id, a `parentId` that is null
at the root of a tree, a tenant absent on a global record. `nullKey: true` produces exactly that.

```sh
N="nk-$(date +%s)"

for i in 1 2 3; do
  curl -sS -D- "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"query QuietNull(\$n: String!) { keyedFault(nonce: \$n, nullKey: true) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
    | grep -iE '^gp-cache|^gp-surrogate-key|errors'
done
```

```
gp-cache: MISS
gp-surrogate-key: ck:145507b1… ck:145507b1…:97f5bb0bff203815 q:keyedFault KeyedFault Query fault KeyedFault:brokenId:

gp-cache: MISS
gp-surrogate-key: … KeyedFault:brokenId:

gp-cache: HIT
gp-cache-hits: 1
gp-cache-max-age: 300
gp-cache-age: 0
gp-surrogate-key: … KeyedFault:brokenId:
```

Two measured facts, and they are the ones worth carrying away from this page.

**The response is stored.** No `errors` array, so nothing refuses it: `HIT`, with the type's full
five minutes. The same answer with the key field resolving hits on the second send rather than the
third; either way the entry exists and is served.

**The key is written with an empty value, not omitted.** `KeyedFault:brokenId:` sits on the stored
entry, with nothing after the final colon. Selecting `brokenId` explicitly changes nothing about it:
the body then carries `"brokenId":null` and the key is still `KeyedFault:brokenId:`.

Put together: the entry is reachable, and it is tagged with a key that names no object. A purge of
`KeyedFault:brokenId:<some-id>` cannot match it, and a purge of the empty key would match every
entry whose key field was null, across every object of that type. Neither side reports anything: the
purge succeeds, the entry stays, and the only visible symptom is stale data nobody can explain. If
your schema has a nullable field feeding a `@surrogateKey(of:)`, that is the failure mode to expect,
and the fix is in the schema rather than in the purge: make the key field non-null, or key the type
on something that always has a value. Tracked as graphpilot-proxy#506.

## The same failure, selected by the client

Change nothing but the selection set:

```sh
  -d "{\"query\":\"query Selected(\$n: String!) { keyedFault(nonce: \$n, failKey: true) { nonce brokenId } }\",\"variables\":{\"n\":\"$N-sel\"}}"
```

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS
{"errors":[{"message":"KeyedFault.brokenId was asked to fail (nonce kf-…-sel)","locations":[{"line":4,"column":5}],"path":["keyedFault","brokenId"],"extensions":{"code":"DEMO_DELIBERATE_FAILURE"}}],"data":{"keyedFault":{"nonce":"kf-…-sel","brokenId":null}}}
```

The error reaches the client in full, because now it names a field the client asked for. Same
origin, same failure, same cache decision, and a different answer: stripping applies to the fields
the edge added and to nothing else. Comparing these two responses is the whole point of the page,
and it is why `docs/17`'s walkthrough on `Fault.broken` is not a test of stripping, however much it
looks like one.

## What proves it

- `gp-surrogate-key` carrying `KeyedFault:brokenId:<value>` on a response whose body has no
  `brokenId`: the field was injected.
- The same header carrying `KeyedFault:brokenId:` with an empty value: the injected field resolved
  to null, whether it threw on the way there or not. Read it beside `gp-cache`: with an error the
  entry was never stored, and with a quiet null it was.
- The absence of an `errors` array on the failing query that did not select `brokenId`, beside its
  presence on the one that did: the entry was stripped rather than never produced.
- `gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS` on both: stripping changes what the client reads,
  never whether the response was stored.
