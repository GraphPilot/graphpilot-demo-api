// The stage leg of the deploy reads secrets and variables under the same names as the production
// leg, and GitHub fills a name the stage environment lacks from the repository. These cases are
// the ways that fallback would publish to the production demo.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deployTargetProblems, renderGpilotConfig } from "../../scripts/deploy-target.ts";

const stage = {
    environment: "stage",
    declaredTarget: "stage",
    apiUrl: "https://api.stage.graphpilot.io/graphql",
    jwksUrl: "https://demo-api.stage.graphpilot.cloud/auth/jwks.json",
};

describe("deployTargetProblems", () => {
    it("lets a configured stage leg deploy", () => {
        expect(deployTargetProblems(stage)).toEqual([]);
    });

    it("lets the production leg deploy with nothing set, as it always has", () => {
        expect(
            deployTargetProblems({
                environment: "production",
                declaredTarget: "",
                apiUrl: "",
                jwksUrl: "",
            }),
        ).toEqual([]);
    });

    it("stops a stage leg whose GPILOT_API_URL fell through to nothing", () => {
        expect(deployTargetProblems({ ...stage, apiUrl: "" }).join("\n")).toMatch(
            /without it the CLI deploys to production/,
        );
    });

    it("stops a stage leg pointed at the production API", () => {
        expect(
            deployTargetProblems({ ...stage, apiUrl: "https://api.graphpilot.io/graphql" }).join(
                "\n",
            ),
        ).toMatch(/points at api\.graphpilot\.io on the stage leg/);
    });

    it("stops a stage leg its environment does not declare as stage", () => {
        expect(deployTargetProblems({ ...stage, declaredTarget: "" }).join("\n")).toMatch(
            /DEPLOY_TARGET/,
        );
    });

    it("stops a stage leg that would publish production's key set", () => {
        expect(
            deployTargetProblems({
                ...stage,
                jwksUrl: "https://demo-api.graphpilot.cloud/auth/jwks.json",
            }).join("\n"),
        ).toMatch(/DEMO_JWKS_URL/);
    });

    it("stops the production leg if someone points it elsewhere", () => {
        expect(deployTargetProblems({ ...stage, environment: "production" }).join("\n")).toMatch(
            /production leg/,
        );
    });

    it("refuses an environment it does not know", () => {
        expect(deployTargetProblems({ ...stage, environment: "staging" })).toEqual([
            'unknown environment "staging", expected production or stage',
        ]);
    });
});

describe("renderGpilotConfig", () => {
    const toml = readFileSync(new URL("../../gpilot.toml", import.meta.url), "utf8");

    it("swaps only the demo provider's jwks_url", () => {
        const out = renderGpilotConfig(toml, stage.jwksUrl);
        expect(out).toContain(`jwks_url = "${stage.jwksUrl}"`);
        expect(out).not.toContain('jwks_url = "https://demo-api.graphpilot.cloud/auth/jwks.json"');
        expect(out.split("\n")).toHaveLength(toml.split("\n").length);
    });

    it("refuses a config with no jwks_url line", () => {
        expect(() => renderGpilotConfig("[auth.providers.demo]\n", stage.jwksUrl)).toThrow(
            /found 0/,
        );
    });

    it("refuses a config with two", () => {
        expect(() => renderGpilotConfig('jwks_url = "a"\njwks_url = "b"\n', stage.jwksUrl)).toThrow(
            /found 2/,
        );
    });
});
