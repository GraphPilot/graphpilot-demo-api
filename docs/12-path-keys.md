# Path keys

**What this shows:** a key that names something other than the object it sits on. `Product` tags
itself with its category's id as well as its own, so one purge evicts every cached **product** in
that category and leaves the other categories alone.

Note the word product. The key is `Product:category.id:audio`, and the type name in front of it is
part of it: this reaches entries holding products, not every entry that mentions the audio
category. A cached `categories` list carries `Category:id:audio` instead, and that is a different
key. See the notes at the end.

```graphql
type Product
    @surrogateKey(of: "id")
    @surrogateKey(of: "category.id")
    @surrogateKey(static: "catalogue") { ... }
```

`of: "category.id"` is a path into the response, and that is the catch worth knowing before you
try it: the key can only be built from values the response actually carries. A query that does not
select `category { id }` produces no `Product:category.id:<id>` key, and a purge naming it will not
reach that entry.

## Send this

Select the category, so the key exists:

```sh
ask() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"query InCategory { product(id: \\\"$1\\\") { id name category { id name } } }\"}" \
    | grep -iE '^gp-cache:|^gp-surrogate-key'
}

ask p01   # audio
ask p01
ask p06   # desks
ask p06
```

`p01` through `p05` are audio, `p06` through `p10` are desks. Purge the audio products:

```sh
gpilot purge --service "$SERVICE" 'Product:category.id:audio'
```

Then ask for both again.

## What comes back

On the way in:

```
gp-cache: MISS   gp-surrogate-key: Product:id:p01 Product:category.id:audio Category:id:audio catalogue
gp-cache: HIT
gp-cache: MISS   gp-surrogate-key: Product:id:p06 Product:category.id:desks Category:id:desks catalogue
gp-cache: HIT
```

After the purge:

```
gp-cache: MISS   (p01, audio)
gp-cache: HIT    (p06, desks)
```

## Which header proves it

`gp-surrogate-key` shows both keys on one entry, which is the whole mechanism: an entry can be
addressed by any of the objects it contains, under any of the names they were tagged with. `gp-cache`
then shows the purge hitting one category and missing the other.

## Notes

- Compare the `gp-surrogate-key` here with the one on [page 1](01-miss-then-hit.md). The same
  product, one extra selection, one extra key. Keys are properties of the response, not of the
  schema in the abstract.
- `Review` uses the same shape from the other direction: `@surrogateKey(of: "productId")` tags a
  cached review `Review:productId:p01`. Note the type name in front. That is **not** the same key
  as `Product:id:p01`, so purging the product does not evict the reviews, and purging the reviews
  does not evict the product. A key is matched as an exact string, type name included. To reach
  both, name both:

  ```sh
  gpilot purge --service "$SERVICE" 'Product:id:p01' 'Review:productId:p01'
  ```

  The same applies to `Inventory:productId:p01` and to `ActivityEntry:productId:p01`. Four types
  tag themselves with the same product id, under four different keys.
- A static key is the one exception, and it is worth seeing the contrast. `catalogue` carries no
  type name at all, so `Product` and `Category` genuinely share it and one purge reaches both. That
  is what makes [static keys](13-static-keys.md) the coarse lever: no type prefix, no precision.
- Where a path key would be right but the field is not selected, the honest fix is a static key
  instead. See [page 13](13-static-keys.md).
