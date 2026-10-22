# Unions and interfaces

**What this shows:** which surrogate keys and which scope a response gets when a field returns a
union or an interface. Which object comes back is decided per row, so the edge decides the keys
per row too. The scope it cannot decide per row: it takes the narrowest scope of every member.

The demo carries three small schemas for this, copied from the proxy's own tests
(`gp-proxy/tests/tests_surrogate_abstract_field_keys.rs`):

| Field | Schema | What it shows |
| --- | --- | --- |
| `library` | `type Library { media: [LibraryMedium!], contents: [LibraryContent!] }`, `union LibraryContent = LibraryBook \| LibraryMagazine \| LibraryMovie` | Keys declared on a union field and an interface field, and a key a member declares itself (`LibraryMovie.genre`) |
| `media`, `book` | `interface Medium @surrogateKey(of: "author.id genre")`, `type Book implements Medium` | Keys declared on the interface itself |
| `lookup(account:)` | `union SearchResult = Book \| Account`, `Account @cacheControl(maxAge: 30, scope: PRIVATE)` | A PUBLIC field with a PRIVATE member |

The data is fixed: a book by `A1` in `Fiction`, a magazine by `A2` in `Tech`, a movie directed by
`D1` in `Drama`. Nothing here is written, so no reset is needed.

Some of what follows changed with runtime 1.5.0. The demo pins no runtime, so it runs whatever was
stable when it was last deployed; the platform API's `activeDeployment { coreVersion }` on the
service says which.

## Send this

```sh
q() {
  curl -sS -D - -o /dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' \
    -H 'gp-client-name: demo-curl' \
    -d "{\"query\":\"$1\"}" | grep -i '^gp-surrogate-key'
}

q 'query Contents { library { contents { ... on LibraryBook { genre author { id } } ... on LibraryMagazine { genre author { id } } ... on LibraryMovie { genre director { id } } } } }'
q 'query Media { media { genre author { name } } }'
q 'query OneBook { book { genre author { name } } }'
```

Change the operation names between runs, or the second run reads the first one's entry.

## What comes back

The union field. Both of `Library.contents`'s keys apply to the members that have the fields they
name, and the movie carries its own `genre` key:

```
Library:contents.author.id:A1:contents.genre:Fiction
Library:contents.author.id:A2:contents.genre:Tech
LibraryMovie:genre:Drama
```

From runtime 1.5.0 the movie also carries `Library:contents.director.id:D1:contents.genre:Drama`.
Up to 1.4.0 the member's own key displaced the union field's key for that member
(graphpilot-proxy#690, fixed in #695), so a purge by the director key missed the movie.

The interface field. `Medium` declares its keys on the type and on two of its fields, and through
`media` they apply both as the interface and as the concrete type:

```
Medium:genre:Fiction   Medium:author.id:A1:genre:Fiction   Book:genre:Fiction   Book:author.id:A1:genre:Fiction
Medium:genre:Tech      Medium:author.id:A2:genre:Tech      Magazine:genre:Tech  Magazine:author.id:A2:genre:Tech
```

From runtime 1.5.0 the automatic keys `Author:id:A1` and `Author:id:A2` are there as well. Up to
1.4.0, `Medium.author @surrogateKey(of: "id")` displaced them.

The implementor through its own type. `book` returns `Book`, not `Medium`. Up to 1.4.0 it carries
only `Author:id:A1`. From runtime 1.5.0 it inherits `Medium`'s keys, as `Medium` and as `Book`
(`Medium:genre:Fiction`, `Medium:author.id:A1:genre:Fiction`, `Book:genre:Fiction` and so on), so a
purge by an interface key reaches it (graphpilot-proxy#709).

## The private member

```sh
for who in user-ada user-grace; do
  T=$(curl -sS "$ORIGIN/auth/token" -H 'content-type: application/json' \
    -d "{\"sub\":\"$who\",\"org\":\"org-acme\",\"role\":\"admin\"}" | jq -r .token)
  curl -sS -D - -o /dev/null "$EDGE/graphql" \
    -H 'content-type: application/json' -H "authorization: Bearer $T" \
    -d '{"query":"query Mine { lookup(account: true) { ... on Account { id } } }"}' | grep -i '^gp-cache:'
done
```

`Query.lookup` says PUBLIC, but `SearchResult` has the PRIVATE member `Account`, and the field has
to be as narrow as its narrowest member. From runtime 1.5.0 both requests answer `MISS`: one entry
per subject, like `Me`. Up to 1.4.0 the field's PUBLIC won, the second caller got `HIT`, and with
it the first caller's account (graphpilot-proxy#691, fixed in #694).

## Where it is tested

`tests/abstract-types.test.ts` in graphpilot-system-tests drives every claim on this page against
the deployed demo, and skips the 1.5.0 ones, saying so, while the demo runs an older runtime.
