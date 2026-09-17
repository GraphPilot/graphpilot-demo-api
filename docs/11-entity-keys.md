# Entity keys

**What this shows:** a cached answer can be addressed by the objects it contains, and evicted by
naming one of them. Purging one product turns its entry into a miss and leaves every other
product's entry alone.

`Product` carries `@surrogateKey(of: "id")`. The proxy reads the `id` field out of each product in
a response and tags the entry with `Product:id:<that value>`. A purge naming that key evicts every
entry carrying it, wherever the product appeared.

`gpilot.toml` sets `surrogate_key.names = ["id"]`, narrower than the default `["id", "_id", "key"]`,
because nothing in this schema carries identity under the other two spellings and a field that
happens to be called `key` should not be mistaken for one.

## Send this

Cache two products:

```sh
ask() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"query One { product(id: \\\"$1\\\") { id name price } }\"}" \
    | grep -iE '^gp-cache:|^gp-surrogate-key'
}

ask p01
ask p01
ask p02
ask p02
```

Read the key off the second response rather than constructing it, then purge:

```sh
gpilot purge --service "$SERVICE" 'Product:id:p01' --format json
```

Then `ask p01` and `ask p02` again.

## What comes back

The first four calls:

```
gp-cache: MISS       gp-surrogate-key: Product:id:p01 catalogue
gp-cache: HIT
gp-cache: MISS       gp-surrogate-key: Product:id:p02 catalogue
gp-cache: HIT
```

The purge reports one key purged. That count is the number the edge actually matched, which is the
number worth reading: zero means the key you named is not one anything was stored under.

After it:

```
gp-cache: MISS       (p01)
gp-cache: HIT        (p02)
```

## Which header proves it

`gp-surrogate-key` on the way in, `gp-cache` on the way out. The first tells you what the entry can
be addressed as; the second tells you the address worked, and that it was narrow enough to leave
the neighbour untouched.

Copy the key out of `gp-surrogate-key` rather than building it by hand. A purge that matched
nothing reads exactly like a purge that did not work, and the usual cause is a key that was typed
rather than read.

## Notes

- A purge does not have to be manual. A mutation's response carries the keys of the objects it
  returned, and the edge treats a key on a mutation response as an immediate purge. `setPrice`
  returns the product it changed, so the price is corrected at the edge without anybody calling
  `gpilot purge`. Try it: cache `p01`, run `setPrice(id: "p01", price: 2450)`, ask again, and the
  answer is a `MISS` carrying the new price.
- `--soft` marks the entry stale instead of evicting it, so the next request is served from the
  stale copy while a revalidation runs, rather than waiting for the origin. It is the gentler lever
  for data that is allowed to be a few seconds old.
- **A product's key does not reach a feed that mentioned the product.** `ActivityEntry` carries
  `@surrogateKey(of: "productId")`, so a cached [activity feed](02-stale-window.md) naming `p01` is
  tagged `ActivityEntry:productId:p01`. That is a different string from `Product:id:p01`, and a
  purge matches keys exactly: the type name is part of the key, and nothing folds two type names
  into one. The purge above leaves the feed exactly where it was.

  Evicting both takes both keys, which the CLI accepts in one call:

  ```sh
  gpilot purge --service "$SERVICE" 'Product:id:p01' 'ActivityEntry:productId:p01'
  ```

  Or the feed's own static key, `activity`, for the whole feed at once. This is the trap worth
  internalising: "it mentions the product, so purging the product clears it" is the intuition, and
  it is wrong. Read the keys off `gp-surrogate-key` and purge the ones you see.
- One product is the narrowest address in this schema. [Page 12](12-path-keys.md) is the next step
  up, and [page 13](13-static-keys.md) the coarsest.
