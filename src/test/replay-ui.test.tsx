import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayRoom } from "@/routes/app.replay";
import { practiceReplayTape } from "@/lib/replay-practice";
import type { ReplayTape } from "@/lib/replay";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/replay-data", () => ({ fetchReplayTape: mocks.load }));
const address = "So11111111111111111111111111111111111111112";
beforeEach(() => {
  mocks.load.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("Replay Room data boundaries", () => {
  it("keeps historical errors visible without substituting a practice tape", async () => {
    mocks.load.mockRejectedValue(new Error("Meteora API returned HTTP 503"));
    render(<ReplayRoom initialPool={address} />);
    fireEvent.click(screen.getByRole("button", { name: "Load historical tape" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("503");
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText("Synthetic practice fixture")).toBeNull();
  });
  it("discards a late historical result after switching to the explicit practice source", async () => {
    let finish!: (tape: ReplayTape) => void;
    mocks.load.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    render(<ReplayRoom initialPool={address} />);
    fireEvent.click(screen.getByRole("button", { name: "Load historical tape" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("radio", { name: "Practice scenario" }));
    const late = {
      ...practiceReplayTape(),
      source: "historical" as const,
      pool: { ...practiceReplayTape().pool, name: "Late historical pool" },
    };
    await act(async () => {
      finish(late);
    });
    expect(screen.queryByText("Late historical pool")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load practice tape" }));
    expect(await screen.findByText("Practice · Switchback Valley")).toBeVisible();
    expect(screen.getByText("Synthetic practice fixture", { exact: false })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Model proposed rebalances/ })).not.toBeChecked();
  });
  it("invalid rules remove computed results and stop playback rather than retaining old decisions", async () => {
    render(<ReplayRoom />);
    fireEvent.click(screen.getByRole("radio", { name: "Practice scenario" }));
    fireEvent.click(screen.getByRole("button", { name: "Load practice tape" }));
    await screen.findByRole("slider");
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(screen.getByRole("button", { name: "Pause replay" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Agent rule command"), {
      target: { value: "predict next month's profit" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("recognise");
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause replay" })).toBeNull();
  });
});
