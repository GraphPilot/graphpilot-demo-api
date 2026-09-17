// Generated from src/schema.graphql by scripts/generate-type-defs.mjs. Do not edit.

export const typeDefs = `
####################################################################################################
# The GraphPilot demo catalogue.
#
# Every cache annotation below carries a one-line comment saying what it demonstrates. Read this
# file top to bottom and you have read the whole caching story: lifetime, scope, stale window and
# the surrogate keys a purge names.
#
# The directive declarations match gp-sdl exactly. The proxy reads the argument names it is
# configured with, and the defaults are \`maxAge\`, \`scope\`, \`inheritMaxAge\`, \`swr\`, and \`@vary(names:)\`
# for the annotation on a custom scope value.
####################################################################################################

"""
How long an answer may be reused, who may reuse it, and for how long it may be served stale.
"""
directive @cacheControl(
    """Fresh lifetime in seconds. 0 means never store."""
    maxAge: Int
    """Which callers share one stored entry."""
    scope: CacheControlScope
    """A child field inherits its parent's lifetime instead of capping it."""
    inheritMaxAge: Boolean
    """Seconds past \`maxAge\` the edge may still serve the stale entry while it revalidates."""
    swr: Int
) repeatable on OBJECT | INTERFACE | UNION | FIELD_DEFINITION | SCALAR | ENUM | INPUT_OBJECT

"""Specifies surrogate keys for CDN cache invalidation"""
directive @surrogateKey(
    """A custom fixed Surrogate Key"""
    static: String
    """GraphQL selection set or path syntax to define the key"""
    of: String
) repeatable on SCALAR | OBJECT | FIELD_DEFINITION | INTERFACE | UNION | ENUM

"""
Names the request discriminators a custom scope value partitions the cache on. Every name must
be derived by a \`[[cache.policy.vary]]\` entry in \`gpilot.toml\`, or the edge refuses the request.
"""
directive @vary(names: [String!]!) on ENUM_VALUE

enum CacheControlScope {
    """One stored entry for everyone. No identity enters the key."""
    PUBLIC

    """One stored entry per caller. Built in, needs no annotation."""
    PRIVATE

    # The bucket in the middle: coarser than one entry per person, narrower than one for all.
    # Two colleagues in one organization with one role share an entry; a different role gets its
    # own, because what they are allowed to see differs.
    """One stored entry per organization and role."""
    ORGANIZATION @vary(names: ["x-gp-organization", "x-gp-role"])
}

####################################################################################################
# Domain
####################################################################################################

# A long-lived type: the reference point for MISS, then HIT, with \`age\` counting up.
# \`swr\` on top of it: after the hour is up the edge may still answer from the stored copy for
# another hour while it fetches a fresh one, so a reader never waits for the origin.
# Three surrogate keys, three purge granularities: this one product, its whole category, or the
# catalogue as a single coarse lever.
type Product
    @cacheControl(maxAge: 3600, scope: PUBLIC, swr: 3600)
    @surrogateKey(of: "id")
    @surrogateKey(of: "category.id")
    @surrogateKey(static: "catalogue") {
    id: ID!
    name: String!
    """Price in minor units, so 1999 is 19.99."""
    price: Int!
    rating: Float!
    category: Category!
    """ISO 8601."""
    updatedAt: String!

    # The short field that caps the long response: a query selecting \`inventory\` alongside the rest
    # of the product is stored for 5 seconds, not for an hour. The lowest lifetime in the selection
    # wins over the whole answer.
    inventory: Inventory! @cacheControl(maxAge: 5)

    reviews: [Review!]!
}

# Categories almost never change, so they live a day and may be served stale for a week while the
# edge revalidates behind the reader's back.
type Category
    @cacheControl(maxAge: 86400, scope: PUBLIC, swr: 604800)
    @surrogateKey(of: "id")
    @surrogateKey(static: "catalogue") {
    id: ID!
    name: String!

    # \`inheritMaxAge\` is the opposite of the \`inventory\` field above: instead of capping the answer
    # at the product's own hour, the list keeps the category's day.
    products: [Product!]! @cacheControl(inheritMaxAge: true)
}

# A review is public and cheap to re-fetch, and carries the product's key so purging a product
# evicts the answers that quoted its reviews too.
type Review
    @cacheControl(maxAge: 300, scope: PUBLIC)
    @surrogateKey(of: "id")
    @surrogateKey(of: "productId") {
    id: ID!
    productId: ID!
    author: String!
    body: String!
    rating: Int!
    """ISO 8601."""
    createdAt: String!
}

# The fast-moving part of the catalogue. Five seconds is short enough that a reserved unit shows up
# almost immediately, and long enough that a burst of readers still shares one origin request.
type Inventory @cacheControl(maxAge: 5, scope: PUBLIC) @surrogateKey(of: "productId") {
    productId: ID!
    available: Int!
    """ISO 8601, null until something is reserved."""
    reservedAt: String
}

# The stale window, close enough to watch.
#
# Every other stale window in this schema is measured in hours, which is the honest lifetime for a
# catalogue and useless for showing the mechanism: nobody waits an hour to see what \`swr\` does. This
# one is five seconds fresh and a minute stale, so the whole cycle fits inside a test run and inside
# a reader's attention.
#
# What to watch. Send the same request three times. The first stores the answer and misses. A second
# within five seconds is a plain hit. A third after six seconds, still inside the minute, is served
# from the same stored entry although it has expired, while the edge fetches a fresh one behind it:
# \`observedAt\` is unchanged, because the answer is the old one, and the request that follows the
# revalidation carries a new \`observedAt\`. Serving the stale copy first is the point: the reader
# waits for the cache, never for the origin.
type Activity @cacheControl(maxAge: 5, scope: PUBLIC, swr: 60) @surrogateKey(static: "activity") {
    # Stamped when a resolver runs, so an answer that came from the stored entry is recognizable:
    # if this did not move, the origin was not reached.
    """ISO 8601, the moment the origin produced this answer."""
    observedAt: String!

    entries: [ActivityEntry!]!
}

# Derived from the catalogue rather than recorded beside it: a price change moves a product's
# \`updatedAt\`, a reservation stamps its inventory, and both surface here. So every mutation in this
# schema changes this answer, which is what makes the feed worth a five second lifetime.
type ActivityEntry @surrogateKey(of: "productId") {
    productId: ID!
    name: String!
    kind: ActivityKind!
    """ISO 8601."""
    at: String!
}

enum ActivityKind {
    PRICE_CHANGED
    STOCK_RESERVED
}

# Private scope: one stored entry per subject. Two tokens never see each other's answer, which is
# the property the system tests prove rather than assume.
type Me @cacheControl(maxAge: 60, scope: PRIVATE) {
    id: ID!
    organizationId: ID!
    role: String!
    favourites: [Product!]!
}

# Bucketed scope in practice: the same numbers for everyone in one organization with one role.
type Report @cacheControl(maxAge: 300, scope: ORGANIZATION) {
    range: ReportRange!
    organizationId: ID!
    role: String!
    revenue: Int!
    orders: Int!
    """ISO 8601."""
    generatedAt: String!
}

enum ReportRange {
    DAY
    WEEK
    MONTH
}

####################################################################################################
# Queries
####################################################################################################

type Query {
    # A public list: one entry for everyone, and the collection key that a newly created product
    # must evict. Without the static key the list would keep its old contents until it expired,
    # because a product that does not exist yet cannot contribute its own key.
    products(category: ID, first: Int = 20, after: ID): [Product!]!
        @cacheControl(maxAge: 300, scope: PUBLIC, swr: 600)
        @surrogateKey(static: "products:collection")

    # The entity read, and the obvious purge target: the answer carries \`Product:id:<id>\`.
    product(id: ID!): Product

    # A very static list, kept behind one coarse key.
    categories: [Category!]! @cacheControl(maxAge: 86400, scope: PUBLIC) @surrogateKey(static: "categories")

    # Variables enter the cache key, so every term is its own entry. A short lifetime keeps the
    # long tail of one-off terms from filling the cache.
    search(term: String!): [Product!]! @cacheControl(maxAge: 60, scope: PUBLIC)

    # The operation a test uses to watch an entry go stale: five seconds fresh, a minute stale, and
    # its own key so a purge can address it without touching the catalogue's.
    activity(first: Int = 5): Activity!
        @cacheControl(maxAge: 5, scope: PUBLIC, swr: 60)
        @surrogateKey(static: "activity")

    # Needs a verified token; without one it answers null.
    me: Me

    # Two tokens in one organization with one role share this answer; a different role gets its own.
    reports(range: ReportRange! = DAY): Report!

    # Uncacheable on purpose: the reference point for "this really came from the origin".
    now: String! @cacheControl(maxAge: 0)
}

####################################################################################################
# Mutations
#
# Never stored. \`maxAge: 0\` on the type says so once, so no individual write has to remember.
# They exist so a purge has something to prove: change a price, then watch the cached answer.
####################################################################################################

input ReviewDraft {
    productId: ID!
    author: String!
    body: String!
    rating: Int!
}

type Mutation @cacheControl(maxAge: 0) {
    setPrice(id: ID!, price: Int!): Product!
    addReview(input: ReviewDraft!): Review!
    reserveStock(id: ID!, count: Int!): Inventory!
    renameCategory(id: ID!, name: String!): Category!
}
`;
