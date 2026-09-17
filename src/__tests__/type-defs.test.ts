import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs build script, deliberately untyped
import { readSdl, render, typeDefsPath } from "../../scripts/generate-type-defs.mjs";

describe("the generated type definitions", () => {
    it("still match src/schema.graphql", () => {
        const onDisk = readFileSync(typeDefsPath(), "utf8");

        expect(onDisk).toBe(render(readSdl()));
    });
});
