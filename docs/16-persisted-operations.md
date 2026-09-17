# Persisted operations

**What this shows:** an operation registered ahead of time is sent as a hash instead of as a
document. The request is smaller, it can go over `GET`, and it caches exactly like the same
operation sent in full.

This is a service-level feature rather than a schema one, so nothing in `src/schema.graphql`
changes. The operations are declared to GraphPilot, and the client sends a hash the edge already
knows.

## Send this

Put the operation in a file:

```sh
cat > one-product.graphql <<'GRAPHQL'
query OneProduct($id: ID!) {
  product(id: $id) {
    id
    name
    price
  }
}
GRAPHQL
```

Register it, and read the hash back:

```sh
gpilot persisted-query push one-product.graphql --service "$SERVICE"
gpilot persisted-query list --service "$SERVICE" --format json
```

Then send it by hash, over `GET`:

```sh
HASH=<the sha256Hash from the list above>

curl -sS -D- -o/dev/null -G "$EDGE/graphql" \
  -H 'gp-client-name: demo-curl' \
  --data-urlencode 'variables={"id":"p01"}' \
  --data-urlencode "extensions={\"persistedQuery\":{\"version\":1,\"sha256Hash\":\"$HASH\"}}" \
  | grep -i '^gp-cache'
```

Twice.

## What comes back

```
gp-cache: MISS
gp-cache-max-age: 3600
```

```
gp-cache: HIT
gp-cache-age: 1
```

The same hour `Product` gets on [page 1](01-miss-then-hit.md), because it is the same operation
against the same schema. The cache does not care how the document arrived.

Revoke it and the entries it filled go with it:

```sh
gpilot persisted-query rm "$HASH" --service "$SERVICE"
```

## Which header proves it

`gp-cache`, and the fact that the request carried no `query` at all. A hash of about sixty bytes
where a document would have been, and the same stored entry either way.

After the revoke, the same request is refused rather than cached: the edge no longer knows the
hash.

## Notes

- Registering operations is also a gate, not only a size optimisation: a service can be configured
  to accept nothing else, which turns "any query a client can write" into "the operations we
  shipped". This demo does not do that, because a demo people are meant to explore has to accept
  ad hoc queries.
- A `GET` is what makes the whole thing worth doing at the edge. A `POST` carries its operation in
  a body that has to be read before anything can be keyed on it; a `GET` is a URL.
- `gpilot persisted-query rm` revokes and purges in one step, which is the behaviour you want: an
  operation nobody can send should not still be answerable from cache.
- Automatic persisted queries (APQ), where the client registers the document itself on first use,
  are a separate mechanism with its own `gpilot apq` commands. The wire format is the same
  `extensions.persistedQuery` shown above.
