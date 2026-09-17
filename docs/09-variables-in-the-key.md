# Variables in the cache key

**What this shows:** two requests for the same operation with different variables are two
different entries. The query text is not the key; the query and its arguments together are.

`Query.search(term)` carries `@cacheControl(maxAge: 60, scope: PUBLIC)`. Sixty seconds, and the
short lifetime is the point: a search term is unbounded input, so every one-off term would
otherwise sit in the cache for as long as a product does, in return for a hit that will never
come.

## Send this

```sh
search() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"query Find(\$t: String!) { search(term: \$t) { id name } }\",\"variables\":{\"t\":\"$1\"}}" \
    | grep -i '^gp-cache:'
}

search desk
search desk
search lamp
search desk
```

## What comes back

```
gp-cache: MISS
gp-cache: HIT
gp-cache: MISS
gp-cache: HIT
```

`lamp` misses even though the operation had already been sent twice, and `desk` still hits
afterwards. Two terms, two entries, neither disturbing the other.

## Which header proves it

The third `gp-cache: MISS`. Same operation name, same query string, same everything except one
variable, and the edge correctly treats it as a question it has not been asked.

## Notes

- The variables go into the key as they were sent. `search(term: "desk")` written inline in the
  query text and `$t = "desk"` sent as a variable are two different requests as far as the key is
  concerned, because the documents differ.
- This is the mechanism behind a class of accident worth knowing about: a variable that carries a
  client-computed timestamp, a request id, or a cache-busting nonce makes every request unique, so
  every request is a `MISS` and the hit rate is zero while everything looks configured correctly.
  If a hit rate is inexplicably flat, look at the variables first.
- The countermeasure is the same as the cause: keep volatile values out of variables, or accept
  that the operation is uncacheable and annotate it `maxAge: 0` so the edge does not store entries
  nobody will ever read.
