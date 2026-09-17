import {
    buildSchema,
    type ConstDirectiveNode,
    type GraphQLNamedType,
    type GraphQLSchema,
    getNamedType,
    isInterfaceType,
    isObjectType,
    isUnionType,
} from "graphql";
import { describe, expect, it } from "vitest";
import { typeDefs } from "../type-defs.ts";

/**
 * The check this repository exists to make copyable.
 *
 * Two mistakes in a GraphQL schema are invisible in review and silent in production, and both have
 * now been made in three different schemas:
 *
 * 1. A composite type with no `@cacheControl`, reached from a field that does not inherit one. The
 *    edge resolves such a field to the default lifetime, and the default is zero unless the
 *    `@cacheControl` declaration gives `maxAge` a default value. A response's lifetime is the
 *    minimum over everything it selects, so one unruled type makes the whole response uncacheable.
 *    Nothing is broken, nothing is logged as an error, and the cache simply never fills.
 *
 * 2. A field-level `@cacheControl` that leaves out `scope` while the type it returns states one. A
 *    field's hint REPLACES the return type's hint rather than merging with it, and a hint that
 *    names no scope is read as private, so a public answer is quietly stored once per caller.
 *
 * Copy this file into your own repository. It needs nothing but `graphql` and your SDL.
 */

interface CacheHint {
    maxAge: number | undefined;
    inheritMaxAge: boolean;
    scope: string | undefined;
}

/** The `@cacheControl` written on one node, or null when it carries none. */
function hintOf(
    node: { readonly directives?: readonly ConstDirectiveNode[] | undefined } | null | undefined,
) {
    const directive = node?.directives?.find((entry) => entry.name.value === "cacheControl");
    if (!directive) {
        return null;
    }

    const argument = (name: string) =>
        directive.arguments?.find((entry) => entry.name.value === name)?.value;

    const maxAge = argument("maxAge");
    const inheritMaxAge = argument("inheritMaxAge");
    const scope = argument("scope");

    return {
        maxAge: maxAge?.kind === "IntValue" ? Number(maxAge.value) : undefined,
        inheritMaxAge: inheritMaxAge?.kind === "BooleanValue" ? inheritMaxAge.value : false,
        scope: scope?.kind === "EnumValue" ? scope.value : undefined,
    } satisfies CacheHint;
}

function isComposite(type: GraphQLNamedType): boolean {
    return isObjectType(type) || isInterfaceType(type) || isUnionType(type);
}

/** Every field reachable from the root types, with the hints that apply to it. */
function* reachableFields(schema: GraphQLSchema) {
    const roots = [schema.getQueryType(), schema.getMutationType()].filter((type) => !!type);
    const queue: GraphQLNamedType[] = [...roots];
    const visited = new Set<string>(queue.map((type) => type.name));

    while (queue.length > 0) {
        const parent = queue.shift();
        if (!parent) {
            break;
        }
        if (isUnionType(parent)) {
            for (const member of parent.getTypes()) {
                if (!visited.has(member.name)) {
                    visited.add(member.name);
                    queue.push(member);
                }
            }
            continue;
        }
        if (!isObjectType(parent) && !isInterfaceType(parent)) {
            continue;
        }

        for (const field of Object.values(parent.getFields())) {
            const returns = getNamedType(field.type);
            yield {
                parent,
                field,
                returns,
                isRoot: parent === schema.getQueryType(),
                fieldHint: hintOf(field.astNode),
                typeHint: hintOf(returns.astNode),
            };
            if (isComposite(returns) && !visited.has(returns.name)) {
                visited.add(returns.name);
                queue.push(returns);
            }
        }
    }
}

/**
 * Fields that resolve to the default lifetime, which is zero here, and therefore zero the whole
 * response they appear in.
 *
 * The rules, in the edge's own order: an explicit `maxAge` wins; `inheritMaxAge` on a non-root
 * field takes the parent's; a root field or a composite field with neither falls back to the
 * default; anything else (a scalar leaf) inherits. So the fields that must carry a lifetime are
 * exactly the root fields and the composite ones.
 */
function unruledFields(sdl: string): string[] {
    const schema = buildSchema(sdl);
    const problems: string[] = [];

    for (const { parent, field, returns, isRoot, fieldHint, typeHint } of reachableFields(schema)) {
        if (!isRoot && !isComposite(returns)) {
            continue;
        }

        const hint = fieldHint ?? typeHint;
        const declares = hint?.maxAge !== undefined;
        const inherits = hint?.inheritMaxAge === true && !isRoot;
        if (declares || inherits) {
            continue;
        }

        problems.push(
            [
                `${parent.name}.${field.name} returns ${returns.name}, and neither the field nor that type carries a @cacheControl with a maxAge.`,
                "The edge resolves such a field to the default max age, which is 0 here because the directive declares `maxAge: Int` with no default value.",
                "A response lives for the shortest lifetime in everything it selects, so this one field makes every response that selects it uncacheable: the edge stores nothing and answers CACHE_SKIPPED_NO_MAX_AGE on every request.",
                `Fix it in one of two places: annotate \`type ${returns.name} @cacheControl(maxAge: ..., scope: ...)\`, or write \`@cacheControl(inheritMaxAge: true, scope: ...)\` on ${parent.name}.${field.name} so it keeps the lifetime of the field above it.`,
            ].join("\n"),
        );
    }

    return problems;
}

/**
 * Fields whose own hint hides a scope written on the type they return.
 *
 * A field's hint replaces the return type's; the two are never merged. So a field annotated for its
 * lifetime alone drops whatever audience its type declared, and an audience nobody states is read
 * as private.
 */
function shadowedScopes(sdl: string): string[] {
    const schema = buildSchema(sdl);
    const problems: string[] = [];

    for (const { parent, field, returns, fieldHint, typeHint } of reachableFields(schema)) {
        if (!fieldHint || fieldHint.scope !== undefined) {
            continue;
        }
        // `maxAge: 0` is never stored, so it has no audience to get wrong. Demanding a scope there
        // would ask every mutation to name a bucket that cannot exist.
        if (fieldHint.maxAge === 0) {
            continue;
        }
        if (!typeHint?.scope) {
            continue;
        }

        problems.push(
            [
                `${parent.name}.${field.name} carries its own @cacheControl with no scope, while ${returns.name} declares \`scope: ${typeHint.scope}\`.`,
                "A field's hint replaces the return type's hint instead of merging with it, so the scope on the type is not read for this field at all.",
                "A hint that names no scope is read as PRIVATE, which stores one entry per caller for an answer meant to be shared.",
                `Fix: write the scope on the field as well, \`@cacheControl(..., scope: ${typeHint.scope})\`.`,
            ].join("\n"),
        );
    }

    return problems;
}

describe("the schema's cache rules", () => {
    it("gives every root and composite field a lifetime", () => {
        expect(
            unruledFields(typeDefs),
            "an unruled composite type makes every response that selects it uncacheable",
        ).toEqual([]);
    });

    it("never lets a field's hint drop the scope its type declares", () => {
        expect(
            shadowedScopes(typeDefs),
            "a hint that states no scope is read as private, so a shared answer is stored per caller",
        ).toEqual([]);
    });
});

// The checks above pass when nothing is wrong, which is also what a check that does nothing looks
// like. These two prove they still bite.
describe("the check itself", () => {
    const DIRECTIVES = `
        directive @cacheControl(maxAge: Int, scope: CacheControlScope, inheritMaxAge: Boolean, swr: Int) repeatable on OBJECT | INTERFACE | UNION | FIELD_DEFINITION | SCALAR | ENUM | INPUT_OBJECT
        enum CacheControlScope { PUBLIC PRIVATE }
    `;

    it("names the type, the field and the consequence when a composite is unruled", () => {
        const problems = unruledFields(`
            ${DIRECTIVES}
            type Query { feed: Feed @cacheControl(maxAge: 5, scope: PUBLIC) }
            type Feed { entries: [Entry!]! }
            type Entry { id: ID! }
        `);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("Feed.entries returns Entry");
        expect(problems[0]).toContain("CACHE_SKIPPED_NO_MAX_AGE");
        expect(problems[0]).toContain("inheritMaxAge: true");
    });

    it("accepts the same schema once the field inherits", () => {
        expect(
            unruledFields(`
                ${DIRECTIVES}
                type Query { feed: Feed @cacheControl(maxAge: 5, scope: PUBLIC) }
                type Feed { entries: [Entry!]! @cacheControl(inheritMaxAge: true, scope: PUBLIC) }
                type Entry { id: ID! }
            `),
        ).toEqual([]);
    });

    it("catches a field hint that drops the scope on its type", () => {
        const problems = shadowedScopes(`
            ${DIRECTIVES}
            type Query { product: Product }
            type Product @cacheControl(maxAge: 3600, scope: PUBLIC) {
                id: ID!
                stock: Stock! @cacheControl(maxAge: 5)
            }
            type Stock @cacheControl(maxAge: 5, scope: PUBLIC) { available: Int! }
        `);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("Product.stock carries its own @cacheControl with no scope");
        expect(problems[0]).toContain("read as PRIVATE");
    });
});
