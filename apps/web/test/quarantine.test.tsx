import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuarantineScreen } from "../src/screens/QuarantineScreen.js";
import { createFakeClient, makeAlias, makeMessage, renderWithApi } from "./helpers.js";

beforeEach(() => {
  window.location.hash = "";
});

function setup(): {
  recoverQuarantine: ReturnType<typeof vi.fn>;
  deleteQuarantine: ReturnType<typeof vi.fn>;
} {
  const messages = [makeMessage({ messageId: "m1", aliasIds: ["a"] })];
  const listQuarantine = vi.fn(async (_query?: unknown) => ({ messages, nextCursor: null }));
  const listAliases = vi.fn(async (_query?: unknown) => ({
    aliases: [makeAlias({ id: "a", label: "Alpha" })],
    nextCursor: null,
  }));
  const recoverQuarantine = vi.fn(async (_id: string, _body: unknown) => ({
    status: "recovered",
    message: messages[0],
  }));
  const deleteQuarantine = vi.fn(async (_id: string, _body: unknown) => ({
    status: "deleted",
    messageId: "m1",
  }));
  const client = createFakeClient({
    listQuarantine,
    listAliases,
    recoverQuarantine,
    deleteQuarantine,
  });
  renderWithApi(<QuarantineScreen />, { client });
  return { recoverQuarantine, deleteQuarantine };
}

describe("QuarantineScreen", () => {
  it("recovers a message", async () => {
    const { recoverQuarantine } = setup();
    const user = userEvent.setup();
    await screen.findByText("shop@example.net");
    await user.click(screen.getByRole("button", { name: "Recover" }));
    await waitFor(() => expect(recoverQuarantine).toHaveBeenCalledWith("m1", {}));
  });

  it("recovers and renews a message", async () => {
    const { recoverQuarantine } = setup();
    const user = userEvent.setup();
    await screen.findByText("shop@example.net");
    await user.click(screen.getByRole("button", { name: "Recover and renew" }));
    await waitFor(() => expect(recoverQuarantine).toHaveBeenCalledWith("m1", { renew: true }));
  });

  it("requires confirmation before deleting", async () => {
    const { deleteQuarantine } = setup();
    const user = userEvent.setup();
    await screen.findByText("shop@example.net");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete message" }));
    await waitFor(() =>
      expect(deleteQuarantine).toHaveBeenCalledWith("m1", { reason: "user_requested" }),
    );
  });

  it("prompts to recover and renew before replying", async () => {
    const { recoverQuarantine } = setup();
    const user = userEvent.setup();
    await screen.findByText("shop@example.net");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Recover and renew before replying/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Recover and renew" }));
    await waitFor(() => expect(recoverQuarantine).toHaveBeenCalledWith("m1", { renew: true }));
    await waitFor(() => expect(window.location.hash).toBe("#/messages/m1/reply"));
  });
});
