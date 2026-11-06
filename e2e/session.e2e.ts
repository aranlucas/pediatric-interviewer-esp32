import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("secure setup failure can be retried into a configurable interview", async ({
  app,
  browser,
  screen,
}) => {
  let available = false;
  await browser.route("**/api/session", async (route) => {
    await route.fulfill(
      available
        ? {
            json: {
              room: "web-0123456789abcdef0123456789abcdef",
              token: "ci-fixture-not-a-real-credential",
              expiresAt: Date.now() + 120_000,
            },
          }
        : { status: 503, json: { error: "session_auth_not_configured" } },
    );
  });
  // The fixture host is loopback; no production agent or model is contacted.
  await app.open("/");
  await expect(screen.getByRole("heading", "Secure connection unavailable")).toBeVisible();
  await expect(screen.getByRole("alert")).toContainText("Secure interviewer setup is unavailable");
  available = true;
  await screen.getByRole("button", "Retry connection").click();
  await expect(screen.getByRole("complementary", "Study topics")).toBeVisible();
  await expect(screen.getByRole("heading", "Secure connection unavailable")).toBeHidden();
  await expect(screen.getByRole("combobox", "Questions")).toHaveValue("6");
  await screen.getByRole("combobox", "Questions").selectOption("3");
  await expect(screen.getByRole("combobox", "Questions")).toHaveValue("3");
  await screen.getByRole("link", "Privacy and data use").click();
  await expect(screen.getByRole("heading", "Privacy and data use")).toBeVisible();
  await screen.getByRole("link", "Back to the interviewer").click();
  await expect(screen.getByRole("complementary", "Study topics")).toBeVisible();
});
