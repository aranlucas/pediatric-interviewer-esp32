import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import PrivacyPage from "../app/privacy/page";

test("privacy page renders its title and safety guidance", () => {
  render(<PrivacyPage />);

  expect(screen.getByRole("heading", { level: 1, name: "Privacy and data use" })).toBeDefined();
  expect(screen.getByText(/Do not enter protected health information/)).toBeDefined();
});
