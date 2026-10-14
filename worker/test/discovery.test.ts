import { expect, test } from "vitest";
import unitConfig from "../vitest.config";
import smokeConfig from "../vitest.smoke.config";

test("production smoke suites stay excluded from the default unit run", () => {
  expect(unitConfig.test?.exclude).toContain("test/live/**");
  expect(smokeConfig.test?.include).toEqual(["test/live/**/*.test.mjs"]);
});
