import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GenerateDialog } from "../src/screens/GenerateDialog.js";
import { DAY_MS, createFakeClient, makeAlias, renderWithApi } from "./helpers.js";

describe("GenerateDialog", () => {
  it("creates the alias on the server before showing the address", async () => {
    const alias = makeAlias({
      address: "green.farm@example.com",
      expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    });
    const createAlias = vi.fn(async (_body: unknown) => ({ alias }));
    const onCreated = vi.fn();
    const client = createFakeClient({ createAlias });
    renderWithApi(<GenerateDialog open onClose={() => undefined} onCreated={onCreated} />, {
      client,
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Label"), "Example Store");
    await user.selectOptions(screen.getByLabelText("Expiration"), "7d");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findByTestId("generated-address");
    expect(createAlias).toHaveBeenCalledTimes(1);
    const body = createAlias.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      label: "Example Store",
      lease: { type: "duration", durationSeconds: 604800 },
    });
    expect(body).not.toHaveProperty("address");
    expect(body).not.toHaveProperty("localPart");
    expect(onCreated).toHaveBeenCalledWith(alias);
  });

  it("copies the generated address", async () => {
    const alias = makeAlias({ address: "green.farm@example.com" });
    const createAlias = vi.fn(async (_body: unknown) => ({ alias }));
    const client = createFakeClient({ createAlias });
    renderWithApi(<GenerateDialog open onClose={() => undefined} onCreated={() => undefined} />, {
      client,
    });
    const user = userEvent.setup();
    // Install the clipboard mock after `userEvent.setup`, which otherwise
    // replaces `navigator.clipboard` with its own stub.
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await user.type(screen.getByLabelText("Label"), "Example Store");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByTestId("generated-address");
    await user.click(screen.getByRole("button", { name: "Copy address" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("green.farm@example.com"));
  });

  it("preserves entered values when creation fails", async () => {
    const createAlias = vi.fn(async (_body: unknown) => {
      throw new Error("boom");
    });
    const client = createFakeClient({ createAlias });
    renderWithApi(<GenerateDialog open onClose={() => undefined} onCreated={() => undefined} />, {
      client,
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Label"), "Example Store");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findByText("boom");
    expect(screen.getByLabelText("Label")).toHaveValue("Example Store");
  });
});
