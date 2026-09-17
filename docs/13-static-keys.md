# Static keys

**What this shows:** the coarse lever. A key that names an area rather than an object, so one
purge clears everything in it at once.

`Product` and `Category` both carry `@surrogateKey(static: "catalogue")`. `Query.categories`
carries `@surrogateKey(static: "categories")`. A static key needs nothing from the response: if the
selection reached the annotated type or field, the key is on the entry.

## Send this

Warm several unrelated entries:

```sh
q() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"$1\"}" \
    | grep -iE '^gp-cache:|^gp-surrogate-key'
}

q 'query A { product(id: \"p01\") { id name } }'
q 'query A { product(id: \"p01\") { id name } }'
q 'query B { products(first: 3) { id name } }'
q 'query B { products(first: 3) { id name } }'
q 'query C { categories { id name } }'
q 'query C { categories { id name } }'
```

Three entries, three hits. Now the lever:

```sh
gpilot purge --service "$SERVICE" catalogue
```

Repeat all three queries.

## What comes back

A, B and C are all `gp-cache: MISS` again. One key, three entries, nothing left standing that
mentioned a product or a category.

Purge `categories` instead and only C misses, because that key sits on one root field rather than
on a type.

## Which header proves it

`gp-surrogate-key`, which carries `catalogue` on every one of the three entries, and `gp-cache`
afterwards. The breadth is visible before you pull the lever, which is the point of switching the
header on.

## Notes

- Placement decides reach. `static: "catalogue"` on a TYPE tags every response that touched that
  type. `static: "categories"` on the FIELD `Query.categories` tags only responses that selected
  that field, so it evicts category lists and leaves `product { category { name } }` alone.
- A static key cannot interpolate the request. It is one global name, so one purge evicts every
  caller's copy, including the buckets and the private entries. That is the trade: maximum reach,
  no precision.
- Reach for it when precision is impossible rather than when it is inconvenient. Anything a purge
  can address by entity key should be, or a routine edit to one product throws away the whole
  catalogue's worth of cached work.
- `gpilot purge --all` is the version with no key at all: the service's entire cache, including
  entries stored before any key existed. Useful after a schema change, and blunt enough that the
  CLI asks before doing it.
