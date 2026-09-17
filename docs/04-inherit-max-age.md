# `inheritMaxAge`

**What this shows:** the opposite of [page 3](03-short-field-caps-the-response.md). A field that
would otherwise drag a response down to its own type's lifetime can say "keep my parent's
instead".

`Category` lives a day. `Product` lives an hour. Without an annotation,
`categories { products { ... } }` would be stored for an hour, because the products in it cap it.
`Category.products` carries `@cacheControl(inheritMaxAge: true)`, so the list keeps the day.

The reason is editorial, not technical: a category's product list changes when the catalogue is
edited, and an edit purges the key. Holding it for an hour would buy nothing except twenty-four
times as many origin requests.

## Send this

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query CategoryTree { categories { id name products { id name } } }"}' \
  | grep -i '^gp-cache'
```

And, for the contrast, the same products reached without going through `Category.products`:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query FlatList { products(category: \"audio\") { id name } }"}' \
  | grep -i '^gp-cache'
```

## What comes back

The tree:

```
gp-cache: MISS
gp-cache-max-age: 86400
```

The flat list:

```
gp-cache: MISS
gp-cache-max-age: 300
```

Same objects, same fields, two very different lifetimes, because one of them was reached through
a field that inherits and the other through `Query.products`, which states five minutes of its
own.

## Which header proves it

`gp-cache-max-age` again: 86400 on the tree. `Product` never says a day anywhere, so a day can only
have come from `Category` through the inheriting field.

## Notes

- `inheritMaxAge` takes the parent's lifetime. It does not mean "unlimited", and it cannot make a
  response live longer than the thing it hangs off.
- It does not change scope. A child of a `PUBLIC` parent is still public; inheritance here is about
  lifetime only.
- Combining it with a fast-moving field is a contradiction worth avoiding: selecting
  `categories { products { inventory { available } } }` still caps at five seconds, because
  `inventory` states a lifetime rather than inheriting one.
