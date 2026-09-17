# Collection keys

**What this shows:** why a list needs a key of its own. An entity key can only address objects a
response already contains, so no entity key can reach a cached list that is wrong precisely because
something new is missing from it.

```graphql
products(category: ID, first: Int = 20, after: ID): [Product!]!
    @cacheControl(maxAge: 300, scope: PUBLIC, swr: 600)
    @surrogateKey(static: "products:collection")
```

This is the one case where reasoning from entity keys leads you astray, so it is worth doing
slowly. A cached `products` response carries `Product:id:p01` through `Product:id:p20`. Add
`p21` and there is no key on that entry that names it, because it was not in the response when the
entry was stored. The list keeps its old contents until it expires, and every entity key in the
world will not evict it.

`products:collection` is the answer: a name for the shape of the answer rather than for its
contents, which anything that changes the membership of the list can purge.

## Send this

Cache the list:

```sh
list() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d '{"query":"query Everything { products(first: 20) { id name } }"}' \
    | grep -iE '^gp-cache:|^gp-surrogate-key'
}

list
list
```

Try to evict it by naming a product that is in it:

```sh
gpilot purge --service "$SERVICE" 'Product:id:p01'
list
```

Then name the collection:

```sh
gpilot purge --service "$SERVICE" 'products:collection'
list
```

## What comes back

```
gp-cache: MISS   gp-surrogate-key: Product:id:p01 ... Product:id:p20 catalogue products:collection
gp-cache: HIT
```

After the entity purge: `gp-cache: MISS`, because `p01` really is in this response and its key
really is on this entry. Entity keys work on lists too, as long as the object is in the list.

After the collection purge: `gp-cache: MISS`, and this is the one that would still have worked if
the change had been an addition rather than an edit.

## Which header proves it

`gp-surrogate-key`, which carries both kinds side by side: twenty entity keys and one collection
key. The entity keys cover every product that is in the list; the collection key covers the
product that is not.

## Notes

- The rule in one sentence: **an entity key evicts a stale object, a collection key evicts a stale
  list.** A creation needs the second, and only the second.
- A deletion has the same shape from the other end. The deleted product's entity key evicts the
  answers that showed it, but the list that should no longer contain it is only reachable through
  the collection key.
- This demo has no `createProduct`, so the walkthrough above proves the mechanism rather than the
  scenario. The scenario is what the system-test suite asserts.
- `Query.categories` carries `static: "categories"` for the same reason, one level coarser. See
  [static keys](13-static-keys.md).
