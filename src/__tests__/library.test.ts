import { type ExecutionResult, type GraphQLSchema, graphql } from "graphql";
import { beforeEach, describe, expect, it } from "vitest";
import type { DemoContext } from "../resolvers/index.ts";
import { createSchema } from "../schema.ts";
import { MemoryStore } from "../store/memory-store.ts";

let schema: GraphQLSchema;

function run(source: string, claims: DemoContext["claims"] = null): Promise<ExecutionResult> {
    return graphql({ schema, source, contextValue: { claims } satisfies DemoContext });
}

beforeEach(() => {
    schema = createSchema(new MemoryStore());
});

describe("the union and interface fields", () => {
    it("answers every member of the library's union with its own fields", async () => {
        const result = await run(`{ library { contents {
            __typename
            ... on LibraryBook { genre author { id } }
            ... on LibraryMagazine { genre author { id } }
            ... on LibraryMovie { genre director { id name } }
        } } }`);

        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({
            library: {
                contents: [
                    { __typename: "LibraryBook", genre: "Fiction", author: { id: "A1" } },
                    { __typename: "LibraryMagazine", genre: "Tech", author: { id: "A2" } },
                    {
                        __typename: "LibraryMovie",
                        genre: "Drama",
                        director: { id: "D1", name: "Dorothy Arzner" },
                    },
                ],
            },
        });
    });

    it("answers the library's interface field with both media", async () => {
        const result = await run("{ library { media { __typename genre author { name } } } }");

        expect(result.errors).toBeUndefined();
        expect(result.data?.library).toEqual({
            media: [
                { __typename: "LibraryBook", genre: "Fiction", author: { name: "Ada Byron" } },
                {
                    __typename: "LibraryMagazine",
                    genre: "Tech",
                    author: { name: "Grace Brewster" },
                },
            ],
        });
    });

    it("answers the MEDIA interface and the book reached through its own type", async () => {
        const result = await run(
            "{ media { __typename genre } book { genre author { id } title } }",
        );

        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual({
            media: [
                { __typename: "Book", genre: "Fiction" },
                { __typename: "Magazine", genre: "Tech" },
            ],
            book: { genre: "Fiction", author: { id: "A1" }, title: "The Analytical Engine" },
        });
    });

    it("looks up the book by default and the caller's own account on request", async () => {
        const query = (account: boolean) =>
            `{ lookup(account: ${account}) { __typename ... on Book { title } ... on Account { id organizationId } } }`;

        const book = await run(query(false));
        expect(book.data?.lookup).toEqual({ __typename: "Book", title: "The Analytical Engine" });

        const claims = { sub: "user-1", org_id: "org-1", role: "viewer" } as DemoContext["claims"];
        const mine = await run(query(true), claims);
        expect(mine.data?.lookup).toEqual({
            __typename: "Account",
            id: "user-1",
            organizationId: "org-1",
        });

        const anonymous = await run(query(true));
        expect(anonymous.data?.lookup).toEqual({
            __typename: "Account",
            id: "anonymous",
            organizationId: "anonymous",
        });
    });
});
