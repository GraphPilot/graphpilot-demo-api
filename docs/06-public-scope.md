# Public scope

**What this shows:** one stored entry for everyone. No identity enters the cache key, so the
answer a signed-in reader warms is the answer an anonymous one gets.

`Query.products`, `Query.categories`, `Query.search`, and the types they return, all carry
`scope: PUBLIC`. A catalogue is the same catalogue whoever is asking, and saying so is what turns
one entry into every reader's answer.

## Send this

Once with no credential at all:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query Shelf { categories { id name } }"}' \
  | grep -i '^gp-cache'
```

Then, immediately, the same query with a token:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"query Shelf { categories { id name } }"}' \
  | grep -i '^gp-cache'
```

## What comes back

The first:

```
gp-cache: MISS
gp-cache-max-age: 86400
```

The second:

```
gp-cache: HIT
gp-cache-age: 1
```

## Which header proves it

`gp-cache: HIT` on the credentialed request. The second caller was handed an entry the first one
filled, which is only correct because both were asking a question whose answer does not depend on
who asked.

Reverse the order and it works the same way: an anonymous reader hits the entry a signed-in one
warmed. That symmetry is what `PUBLIC` means. It is also what a hint with no scope means, because a
missing scope reads as `PUBLIC` (Apollo's default). So write the scope down anyway, and anything
meant for one caller has to say `scope: PRIVATE` itself.

## Notes

- Public is the strongest claim in the schema and the only one you can get catastrophically wrong.
  It says this answer is safe to hand to a stranger. Nothing in this demo says it about anything
  derived from a token.
- The next two pages are the other two answers: [one entry per subject](07-private-scope.md) and
  [one entry per organization and role](08-buckets.md).
