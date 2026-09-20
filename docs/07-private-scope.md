# Private scope

**What this shows:** one stored entry per caller. Two tokens never share an answer, and the proof
is that the second token's first request is a `MISS` even though the first token has already
warmed the same query.

`type Me` carries `@cacheControl(maxAge: 60, scope: PRIVATE)`. `gpilot.toml` says what "per
caller" means here:

```toml
[cache.policy]
private = 'auth:demo.sub'
```

The subject claim of a verified token, and nothing else. A request with no verifiable subject has
no discriminator, so there is nothing to key a private entry on and the answer is not stored at
all.

## Send this

Two tokens, two people:

```sh
ADA=$(curl -sS "$ORIGIN/auth/token" -H 'content-type: application/json' \
  -d '{"sub":"user-ada","org":"org-acme","role":"admin"}' | jq -r .token)
GRACE=$(curl -sS "$ORIGIN/auth/token" -H 'content-type: application/json' \
  -d '{"sub":"user-grace","org":"org-acme","role":"admin"}' | jq -r .token)
```

Note that they are in the same organization with the same role. Only the subject differs.

```sh
for who in "$ADA" "$ADA" "$GRACE"; do
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -H "authorization: Bearer $who" \
    -d '{"query":"query Viewer { me { id organizationId role } }"}' \
    | grep -i '^gp-cache:'
done
```

## What comes back

```
gp-cache: MISS
gp-cache: HIT
gp-cache: MISS
```

Ada misses, then hits her own entry. Grace misses, because Ada's entry is not hers, however alike
the two of them look to every other part of this configuration.

## Which header proves it

The third `gp-cache: MISS`. A shared entry would have made it a `HIT`, and the body would have
carried `user-ada` to Grace.

Run Grace's request twice and the second is a `HIT` on her own entry: private does not mean
uncacheable, it means one entry each.

## Notes

- Send the same query with no token at all and the answer is `gp-cache: PASS` with
  `gp-cache-reason: CACHE_SKIPPED_PRIVATE_WITHOUT_DISCRIMINATOR`. That is the correct refusal: with
  no subject there is no key that could safely hold the answer, so nothing is stored rather than
  something being stored under a key everyone shares.
- Private is also the fallback. A `@cacheControl` hint naming no scope lands here, because reading
  a missing scope as public is the mistake that leaks data, and reading it as private is the
  mistake that costs a cache hit.
- One entry per person is not always what you want. When the answer is identical for a whole team,
  [a bucket](08-buckets.md) stores it once instead of once each.
