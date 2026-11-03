# Vary from a header, a cookie and the origin

**What this shows:** three more ways an entry is partitioned besides a verified claim. A
`[[cache.policy.vary]]` entry that reads a request header, one that reads a cookie, and the
origin's own `Vary` response header. Along the way it shows what the origin receives for each
`pass_to_origin` setting other than `never`.

[Page 8](08-buckets.md) partitions on claims from a verified token, and both of its entries stay at
the edge. That is the right shape for a boundary (who the caller is, which organization). For a
preference the caller is entitled to choose, such as an edition or an A/B bucket, a header or a
cookie is the right source, and the origin often needs to be told the value.

## The two entries

```toml
[[cache.policy.vary]]
name = "x-demo-edition"
value = "lower(header:x-demo-edition-pref) || 'standard'"
pass_to_origin = "plain"

[[cache.policy.vary]]
name = "x-demo-ab"
value = "cookie:demo_ab || 'none'"
pass_to_origin = "anonymized"
```

- `x-demo-edition` is read from the `x-demo-edition-pref` header, lowercased, and sent to the origin
  **as it was derived**.
- `x-demo-ab` is read from the `demo_ab` cookie and sent to the origin as `v1=` followed by a keyed
  HMAC-SHA256 digest. The key belongs to the service and is never sent to the origin, so the origin
  can tell two buckets apart without learning their names.
- Configuring an entry **claims its name**: an `x-demo-edition` or `x-demo-ab` header a client sends
  itself is removed on the way in, so whatever the origin receives under those names was derived by
  the edge.
- The fallbacks (`|| 'standard'`, `|| 'none'`) keep every request that sends neither in the entry it
  had before. Neither entry is `scope_only` (that is refused beside `plain` or `anonymized`), so both
  partition every response, and without a fallback a signed-in caller who sends no preference would
  not be stored at all (`CACHE_SKIPPED_PRIVATE_WITHOUT_DISCRIMINATOR`).

## What the origin receives

The header echo from [page 19](19-a-misbehaving-origin.md) asks the origin directly:

```sh
N="vary-$(date +%s)"

curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "x-demo-scope-nonce: $N" \
  -H 'x-demo-echo-headers: x-demo-edition,x-demo-ab,x-demo-edition-pref' \
  -H 'x-demo-edition-pref: Hardcover' \
  -H 'x-demo-edition: forged-by-the-client' \
  -H 'cookie: demo_ab=b' \
  -d "{\"query\":\"query V(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
  | grep -i '^x-demo-received-headers'
```

```
x-demo-received-headers: {"x-demo-edition":"hardcover","x-demo-ab":"v1=…","x-demo-edition-pref":"Hardcover"}
```

- `x-demo-edition` is `hardcover`: the derived value, lowercased by the expression, not the
  `forged-by-the-client` the request carried under that name.
- `x-demo-ab` is `v1=` and 43 base64url characters. The same cookie value gives the same digest on
  every request, a different one a different digest, and `b` appears nowhere in it.
- `x-demo-edition-pref` is an ordinary header and arrives untouched. The origin should render from
  the derived header, not from the source: the entry is keyed on what the expression derived.

## Two preferences, two entries

Ask the same question twice with one edition and once with another:

```sh
N="vary-$(date +%s)"
ask() {
  curl -sS -D- -o/dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    "$@" \
    -d "{\"query\":\"query V(\$n: String!) { faulty(nonce: \$n) { nonce } }\",\"variables\":{\"n\":\"$N\"}}" \
    | grep -i '^gp-cache:'
}

ask -H 'x-demo-edition-pref: hardcover'
ask -H 'x-demo-edition-pref: HARDCOVER'
ask -H 'x-demo-edition-pref: paperback'
```

```
gp-cache: MISS
gp-cache: HIT
gp-cache: MISS
```

`HARDCOVER` derives `hardcover` and reads the first entry; `paperback` gets its own. The cookie
behaves the same way: `-H 'cookie: demo_ab=a'` and `-H 'cookie: demo_ab=b'` are two entries.

## The origin's own `Vary`

An origin can partition without any configuration by naming request headers in `Vary`. The
`x-demo-vary` lever sets one (with the `ask` from above, which reads `$N` when it runs):

```sh
N="vary-lang-$(date +%s)"
ask -H "x-demo-scope-nonce: $N" -H 'x-demo-vary: accept-language' -H 'accept-language: de'
ask -H "x-demo-scope-nonce: $N" -H 'x-demo-vary: accept-language' -H 'accept-language: de'
ask -H "x-demo-scope-nonce: $N" -H 'x-demo-vary: accept-language' -H 'accept-language: en'
```

```
gp-cache: MISS
gp-cache: HIT
gp-cache: MISS
```

This **adds** to the vary entries above: one entry per language and per edition.

`Vary: *` is the one value that does not work. RFC 9111 says it never matches a later request, so
the edge does not store the answer:

```sh
N="vary-star-$(date +%s)"
ask -H "x-demo-scope-nonce: $N" -H 'x-demo-vary: *'
```

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_VARY_WILDCARD
```

(`ask` above only prints `gp-cache:`; widen its `grep` to `'^gp-cache'` to see the reason.)

## Proven by

`graphpilot-system-tests`: `tests/vary-pass-to-origin.test.ts` (what the origin receives),
`tests/vary-sources.test.ts` (header and cookie partitioning) and `tests/origin-vary.test.ts` (the
origin's `Vary`).
