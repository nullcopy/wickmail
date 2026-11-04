import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "wickmail-core";
import { ReplyComposerScreen } from "../src/screens/ReplyComposerScreen.js";
import { createFakeClient, makeReplyContext, renderWithApi } from "./helpers.js";

const aliasA = { kind: "alias", aliasId: "a", address: "green.farm@example.com" } as const;
const aliasB = { kind: "alias", aliasId: "b", address: "blue.sky@example.com" } as const;
const primary = { kind: "primary", address: "me@example.com" } as const;

describe("ReplyComposerScreen", () => {
  it("requires an explicit choice when multiple aliases received the message", async () => {
    const context = makeReplyContext({
      identity: { selection: "prompt", selected: null, options: [aliasA, aliasB] },
    });
    const getReplyContext = vi.fn(async (_id: string) => context);
    const submitReply = vi.fn(async (_id: string, _body: unknown) => ({
      messageId: "out-1",
      identity: aliasA,
      renewed: true,
      expiresAt: null,
    }));
    const client = createFakeClient({ getReplyContext, submitReply });
    renderWithApi(<ReplyComposerScreen id="msg-1" />, { client });
    const user = userEvent.setup();

    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "Thanks!");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await screen.findByText(/Choose which alias/);
    expect(submitReply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "green.farm@example.com" }));
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await screen.findByText(/Reply queued/);
    expect(submitReply).toHaveBeenCalledWith("msg-1", expect.objectContaining({ aliasId: "a" }));
  });

  it("preselects the single receiving alias and can send as the primary instead", async () => {
    const context = makeReplyContext({
      identity: { selection: "default", selected: aliasA, options: [aliasA, primary] },
    });
    const getReplyContext = vi.fn(async (_id: string) => context);
    const submitReply = vi.fn(async (_id: string, _body: unknown) => ({
      messageId: "out-2",
      identity: primary,
      renewed: false,
      expiresAt: null,
    }));
    const client = createFakeClient({ getReplyContext, submitReply });
    renderWithApi(<ReplyComposerScreen id="msg-1" />, { client });
    const user = userEvent.setup();

    await screen.findByLabelText("Message");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "green.farm@example.com" })).toBeChecked(),
    );

    await user.click(screen.getByRole("radio", { name: "me@example.com (primary address)" }));
    await user.type(screen.getByLabelText("Message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await screen.findByText(/Reply queued/);
    expect(submitReply).toHaveBeenCalledWith("msg-1", expect.objectContaining({ aliasId: null }));
  });

  it("explains an identity error and offers alternatives", async () => {
    const context = makeReplyContext();
    const getReplyContext = vi.fn(async (_id: string) => context);
    const submitReply = vi.fn(async (_id: string, _body: unknown) => {
      throw new ApiClientError(409, "conflict", "selected alias did not receive this message");
    });
    const client = createFakeClient({ getReplyContext, submitReply });
    renderWithApi(<ReplyComposerScreen id="msg-1" />, { client });
    const user = userEvent.setup();

    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await screen.findByText(/did not receive this message/);
    expect(screen.getByText(/Choose a different identity/)).toBeInTheDocument();
    // The entered body is preserved.
    expect(screen.getByLabelText("Message")).toHaveValue("Hello");
  });
});
