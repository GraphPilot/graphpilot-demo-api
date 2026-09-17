# A short field caps the whole response

**What this shows:** a response is only as cacheable as the least cacheable thing in it. Selecting
one five-second field alongside an hour-long type stores the whole answer for five seconds.

`Product` lives an hour. `Product.inventory` carries `@cacheControl(maxAge: 5)`, because stock
moves and a reader looking at it wants something close to true. A field hint beats the type's, and
the lifetime of a response is the minimum over everything selected.

## Send this

The same product as [page 1](01-miss-then-hit.md), with one more field:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query ProductWithStock { product(id: \"p01\") { id name price inventory { available } } }"}' \
  | grep -i '^gp-cache'
```

## What comes back

```
gp-cache: MISS
gp-cache-max-age: 5
```

Five, where the query without `inventory` reported 3600. Wait six seconds, send it again, and the
answer is a `MISS` rather than a `HIT`: the entry has expired.

## Which header proves it

`gp-cache-max-age`. Run the two queries side by side and the number is the only thing that
changes: same product, same edge, same everything, one extra field, and the lifetime drops by a
factor of seven hundred.

## Notes

- This is not a mistake to design around, it is the honest answer. An entry holding both values
  can only be as fresh as the fresher half of it demands.
- It does mean a client that wants the long-lived fields cached should not ask for the fast-moving
  one in the same operation. Two operations, two entries, two lifetimes.
- The reverse move exists too: a field can opt out of capping its parent. That is
  [`inheritMaxAge`](04-inherit-max-age.md).
