# `inheritMaxAge`

**What this shows:** the opposite of [page 3](03-short-field-caps-the-response.md). A field that
would otherwise drag a response down to its own type's lifetime can say "keep my parent's instead".

And, in the same breath, the condition that has to hold before it does anything at all. This page
demonstrates both, because the schema happens to contain one field where inheritance works and one
where it is asked for and refused. That contrast is more useful than either half alone.

## The rule

> `inheritMaxAge` on a field applies **only when the field's return type states no `maxAge` of its
> own**. If the type states one, the type's lifetime wins and the annotation does nothing.

It follows Apollo Server's behaviour, and since graphpilot-proxy#488 a field's `@cacheControl` is
laid over its return type's argument by argument rather than replacing it whole.

## Where it works

`Activity.entries` carries `@cacheControl(inheritMaxAge: true, scope: PUBLIC)` and returns
`ActivityEntry`, which carries **no** `@cacheControl` at all. There is no type lifetime to beat, so
the entries keep the feed's own five seconds.

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query Feed { activity { observedAt entries { productId kind at } } }"}' \
  | grep -i '^gp-cache'
```

```
gp-cache: MISS
gp-cache-max-age: 5
```

Five seconds, stated once on `Activity` and kept by the entries. Without the annotation,
`ActivityEntry` would resolve to the default lifetime of zero and one such field would make the
whole response uncacheable, which is what `src/__tests__/cache-control-coverage.test.ts` walks the
schema for.

## Where it is asked for and refused

`Category.products` carries the same annotation and returns `Product`, which **does** state a
lifetime: `@cacheControl(maxAge: 3600)`. So the product's hour wins and the category's day never
reaches the list.

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query CategoryTree { categories { id name products { id name } } }"}' \
  | grep -i '^gp-cache'
```

```
gp-cache: MISS
gp-cache-max-age: 3600
```

An hour, not the 86400 the annotation is asking for. The annotation is not broken and it is not
ignored for no reason: it is stating a preference that the return type outranks.

To make this list actually keep the day, `type Product` would have to drop its own `maxAge`, which
would be the wrong trade for the rest of this catalogue. It is left as it is precisely so the page
has something to show.

## For the contrast, a third lifetime

The same objects reached through `Query.products`, which states five minutes of its own:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -d '{"query":"query FlatList { products(category: \"audio\") { id name } }"}' \
  | grep -i '^gp-cache'
```

```
gp-cache: MISS
gp-cache-max-age: 300
```

Same objects, same fields, three different lifetimes, decided entirely by the path they were
reached through.

## Which header proves it

`gp-cache-max-age`, on each of the three. It is the only place a resolved lifetime is visible: the
bodies are identical whichever path produced them.

## Notes

- `inheritMaxAge` takes the parent's lifetime. It does not mean "unlimited", and it cannot make a
  response live longer than the thing it hangs off.
- It does not change scope. A child of a `PUBLIC` parent is still public; inheritance here is about
  lifetime only.
- The reverse also holds since #488: a type's `inheritMaxAge` carries over to a field that states no
  `maxAge` of its own.
- Combining it with a fast-moving field is a contradiction worth avoiding: selecting
  `categories { products { inventory { available } } }` still caps at five seconds, because
  `inventory` states a lifetime rather than inheriting one.
