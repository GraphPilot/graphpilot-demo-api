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
- The same header carrying `KeyedFault:brokenId:` with an empty value: the injected field failed.
- The absence of an `errors` array on the failing query that did not select `brokenId`, beside its
  presence on the one that did: the entry was stripped rather than never produced.
- `gp-cache-reason: CACHE_SKIPPED_GRAPHQL_ERRORS` on both: stripping changes what the client reads,
  never whether the response was stored.
