import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "../src/screens/DashboardScreen.js";
import { DAY_MS, NOW, createFakeClient, makeAlias, makeMessage, renderWithApi } from "./helpers.js";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function setup(): {
  listAliases: ReturnType<typeof vi.fn>;
  listQuarantine: ReturnType<typeof vi.fn>;
  onGenerate: ReturnType<typeof vi.fn>;
} {
  const aliases = [
    makeAlias({
      id: "a",
      label: "Alpha",
      state: "active",
      expiresAt: iso(NOW + 3 * DAY_MS),
      createdAt: iso(NOW - 10 * DAY_MS),
      lastInboundAt: iso(NOW - 2 * DAY_MS),
    }),
    makeAlias({
      id: "b",
      label: "Bravo",
      state: "active",
      expiresAt: null,
      createdAt: iso(NOW - 5 * DAY_MS),
    }),
    makeAlias({
      id: "c",
      label: "Charlie",
      state: "expired",
      expiresAt: iso(NOW - DAY_MS),
      createdAt: iso(NOW - DAY_MS),
    }),
  ];
  const messages = [makeMessage({ messageId: "m1", aliasIds: ["a"] })];
  const listAliases = vi.fn(async () => ({ aliases, nextCursor: null }));
  const listQuarantine = vi.fn(async () => ({ messages, nextCursor: null }));
  const onGenerate = vi.fn();
  const client = createFakeClient({ listAliases, listQuarantine });
  renderWithApi(<DashboardScreen onGenerate={onGenerate} />, { client });
  return { listAliases, listQuarantine, onGenerate };
}

describe("DashboardScreen", () => {
  it("renders counts, rows, and per-alias quarantine counts", async () => {
    setup();
    await screen.findByText("Alpha");
    expect(within(screen.getByTestId("count-active")).getByText("2")).toBeInTheDocument();
    expect(within(screen.getByTestId("count-expiring")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("count-expired")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("count-quarantined")).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getAllByText("No expiry").length).toBeGreaterThan(0);
    expect(screen.getByText("1 quarantined")).toBeInTheDocument();
  });

  it("defaults to expiry order with no-expiry aliases last", async () => {
    setup();
    await screen.findByText("Alpha");
    const labels = screen.getAllByRole("link").map((link) => link.textContent);
    // Charlie (expired, soonest) first; Bravo (no expiry) last.
    expect(labels).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("derives the server query from the search box", async () => {
    const { listAliases } = setup();
    const user = userEvent.setup();
    await screen.findByText("Alpha");
    await user.type(screen.getByLabelText("Search"), "merchant");
    await waitFor(() =>
      expect(listAliases).toHaveBeenCalledWith(expect.objectContaining({ search: "merchant" })),
    );
  });

  it("derives the server query from the sort control", async () => {
    const { listAliases } = setup();
    const user = userEvent.setup();
    await screen.findByText("Alpha");
    await user.selectOptions(screen.getByLabelText("Sort by"), "created");
    await waitFor(() =>
      expect(listAliases).toHaveBeenCalledWith(
        expect.objectContaining({ sort: "created", order: "desc" }),
      ),
    );
    await waitFor(() => {
      const labels = screen.getAllByRole("link").map((link) => link.textContent);
      expect(labels).toEqual(["Charlie", "Bravo", "Alpha"]);
    });
  });

  it("invokes generate from the prominent button", async () => {
    const { onGenerate } = setup();
    const user = userEvent.setup();
    await screen.findByText("Alpha");
    await user.click(screen.getByRole("button", { name: "Generate alias" }));
    expect(onGenerate).toHaveBeenCalled();
  });
});
