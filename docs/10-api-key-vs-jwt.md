# An API key caches nothing

**What this shows:** an API key is an opaque credential. The edge cannot read anything out of it,
so it derives no subject, no organization and no role, and a response that needs one of those to
be keyed safely is not stored at all.

This surprises people, so it is worth stating as a rule before the walkthrough: **a request whose
answer depends on identity can only be cached when the edge can verify that identity itself.** A
JWT it can. An API key it cannot, because there is no signature and no key material to check one
against.

`gpilot.toml` configures both providers:

```toml
[auth.providers.demo]
type = "jwt"
allowed_algorithms = ["RS256"]
jwks_url = "https://demo-api.graphpilot.cloud/auth/jwks.json"

[auth.providers.apikey]
type = "api_key"
prefixes = ["demo_sk_"]
```

The API key provider verifies nothing, and that is its entire job. Without it, the JWT provider
reading the same `Authorization` header would turn every API key away as a malformed token. With
it, the prefix marks the credential as somebody else's business, the request reaches the origin,
and the origin decides whether the key is any good.

## Send this

A private query, once with a token and once with a key:

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"query Viewer { me { id organizationId } }"}' \
  | grep -i '^gp-cache'
```

```sh
curl -sS -D- -o/dev/null "$EDGE/graphql" \
  -H 'content-type: application/json' \
  -H 'gp-client-name: demo-curl' \
  -H 'authorization: Bearer demo_sk_anything' \
  -d '{"query":"query Viewer { me { id organizationId } }"}' \
  | grep -i '^gp-cache'
```

Then the same pair against the bucketed query, `reports(range: WEEK)`.

## What comes back

With a token, the second time:

```
gp-cache: HIT
```

With an API key, every time:

```
gp-cache: PASS
gp-cache-reason: CACHE_SKIPPED_PRIVATE_WITHOUT_DISCRIMINATOR
```

## Which header proves it

`gp-cache-reason: CACHE_SKIPPED_PRIVATE_WITHOUT_DISCRIMINATOR`. It names the exact thing that is
missing: `cache.policy.private` is `auth:demo.sub`, an API key carries no `demo.sub`, so there is
no discriminator to key a private entry on.

Refusing to store is the correct outcome, not a defect. The alternative would be filing the
response under a key that does not distinguish callers, which is one caller being served another's
data.

## Notes

- Public queries are unaffected. `products`, `categories` and `search` are the same answer for
  everyone, so an API key hits them exactly as an anonymous reader does. It is only the answers
  that depend on who is asking that an API key cannot have cached.
- The same reasoning covers the bucketed query: no `org_id` and no `role` claim means neither
  bucket header is derived, so `reports` is never stored for an API key either.
- If you want API key traffic cached, the fix is not a cache setting. It is a credential the edge
  can verify, which means a JWT.
- This demo does not validate API keys at all: any value starting with `demo_sk_` is accepted as
  opaque and resolves to no viewer, so `me` answers null. A real origin would check it.
