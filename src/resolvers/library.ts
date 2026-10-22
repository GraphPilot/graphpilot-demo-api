import type { DemoContext } from "./index.ts";

/**
 * The union and interface fields: `library`, `media`, `book` and `lookup`.
 *
 * Static data and no store, because nothing here is ever written: the point of these fields is the
 * keys and the scope the edge derives for an abstract type, and those depend only on the shape of
 * the answer. Every object carries its `__typename`, which is how graphql-js's default type
 * resolver picks the member of a union or the implementor of an interface.
 *
 * The values match the proxy's tests (`tests_surrogate_abstract_field_keys.rs`), so the keys the
 * demo answers with can be read beside the proxy's snapshots: a book by A1 in Fiction, a magazine
 * by A2 in Tech, a movie directed by D1 in Drama.
 */

interface Author {
    id: string;
    name: string;
}

const AUTHORS = {
    A1: { id: "A1", name: "Ada Byron" },
    A2: { id: "A2", name: "Grace Brewster" },
    D1: { id: "D1", name: "Dorothy Arzner" },
} satisfies Record<string, Author>;

const LIBRARY_BOOK = { __typename: "LibraryBook", genre: "Fiction", author: AUTHORS.A1 };
const LIBRARY_MAGAZINE = { __typename: "LibraryMagazine", genre: "Tech", author: AUTHORS.A2 };
const LIBRARY_MOVIE = { __typename: "LibraryMovie", genre: "Drama", director: AUTHORS.D1 };

const BOOK = {
    __typename: "Book",
    genre: "Fiction",
    author: AUTHORS.A1,
    title: "The Analytical Engine",
};
const MAGAZINE = { __typename: "Magazine", genre: "Tech", author: AUTHORS.A2 };

/** What an unauthenticated caller counts as, as in `reports`. */
const ANONYMOUS = "anonymous";

export function libraryQueryResolvers() {
    return {
        library: () => ({
            media: [LIBRARY_BOOK, LIBRARY_MAGAZINE],
            contents: [LIBRARY_BOOK, LIBRARY_MAGAZINE, LIBRARY_MOVIE],
        }),

        media: () => [BOOK, MAGAZINE],

        book: () => BOOK,

        // The book unless the caller asks for their own account. The account is built from the
        // verified claims alone, so two tokens provably get two different answers.
        lookup: (_root: unknown, args: { account: boolean }, context: DemoContext) =>
            args.account
                ? {
                      __typename: "Account",
                      id: context.claims?.sub ?? ANONYMOUS,
                      organizationId: context.claims?.org_id ?? ANONYMOUS,
                  }
                : BOOK,
    };
}
