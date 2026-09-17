# Buckets

**What this shows:** the scope in the middle. Coarser than one entry per person, narrower than one
entry for everyone: one entry per organization and role. Two colleagues share it; the same
colleague in a different role does not.

This takes two halves that have to agree, and the order they are written in matters.

**The configuration derives the values.** `gpilot.toml`:

```toml
[[cache.policy.vary]]
name = "x-gp-organization"
value = 'auth:demo.org_id'

[[cache.policy.vary]]
name = "x-gp-role"
value = 'auth:demo.role'
```

**The schema names them.** `src/schema.graphql`:

```graphql
enum CacheControlScope {
    PUBLIC
    PRIVATE
    ORGANIZATION @vary(names: ["x-gp-organization", "x-gp-role"])
}

type Report @cacheControl(maxAge: 300, scope: ORGANIZATION) { ... }
```

The entries may land before the schema that names them: until something names a header, deriving
it does nothing, so a `[[cache.policy.vary]]` entry nobody uses is inert. The other order does not
work. A `@vary` name that no entry derives is refused on every request, so the service would be
serving from the origin with nothing in the logs saying why. Configuration first, schema second,
every time.

## Send this

Three tokens: two colleagues, and one of them demoted.

```sh
mint() {
  curl -sS "$ORIGIN/auth/token" -H 'content-type: application/json' \
    -d "{\"sub\":\"$1\",\"org\":\"$2\",\"role\":\"$3\"}" | jq -r .token
}

ADA_ADMIN=$(mint user-ada   org-acme admin)
BEN_ADMIN=$(mint user-ben   org-acme admin)
BEN_VIEWER=$(mint user-ben  org-acme viewer)
OTHER=$(mint user-zoe       org-beta admin)
```

```sh
for who in "$ADA_ADMIN" "$BEN_ADMIN" "$BEN_VIEWER" "$OTHER"; do
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -H "authorization: Bearer $who" \
    -d '{"query":"query Numbers { reports(range: WEEK) { organizationId role revenue orders } }"}' \
    | grep -iE '^gp-cache'
done
```

## What comes back

```
gp-cache: MISS
gp-cache: HIT
gp-cache: MISS
gp-cache: MISS
```

Ada fills the entry. Ben, in the same organization with the same role, is handed it: a different
person, the same answer, one origin request between them. Ben as a viewer misses, because a viewer
is not entitled to what an admin was shown. Zoe misses, because a different organization is a
different bucket entirely.

## Which header proves it

`gp-cache`, read across the four requests rather than on any one of them. The second is the whole
feature: a `HIT` for somebody who has never sent this request before. The third and fourth are the
boundaries of the bucket, and a design that got them wrong would show up here as a `HIT`.

The names the entry is partitioned on are not on the response. The `vary` a client sees is the
origin's own, and the bucket headers are the proxy's business: they are derived, used as part of
the key, and stripped. So the evidence that the schema's `@vary` and the two
`[[cache.policy.vary]]` entries found each other is behavioural, which is the honest place for it
to be. `gpilot requests --format json` carries the same decision per request if you want it
written down.

## Notes

- The role is in the bucket because an organization on its own is not a safe key. A cache hit never
  reaches the origin, so whatever the origin would have checked for the second caller is not
  checked. Keyed on the organization alone, Ben the viewer would have been handed Ada's numbers.
  The rule is that a bucket must be exactly as fine-grained as the authorization behind it, and no
  finer.
- `x-gp-organization`, not `gp-organization`. The `gp-` prefix is the proxy's own namespace and is
  stripped from every client request, so a bucket header named inside it could never be backed.
- Neither header reaches the origin. `pass_to_origin` defaults to `never`, and this origin reads
  `org_id` and `role` off the token itself, so a header restating a claim it already has would be
  one more thing that can disagree with the token.
- `Report.generatedAt` is a live timestamp, so two bucketed answers are identical only while they
  come from one entry. That is a feature for this walkthrough: if `generatedAt` changed, the origin
  was reached.
- A request with no token derives neither header and lands in the anonymous bucket, which shares
  nothing with any of the four above. An API key derives neither either, and is
  [not stored at all](10-api-key-vs-jwt.md).
