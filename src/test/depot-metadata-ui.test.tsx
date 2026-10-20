import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/recorder-store", () => ({ recordFact: vi.fn().mockResolvedValue(undefined) }));
import { MetadataPublisher } from "@/components/depot/MetadataPublisher";

const agent = { id: "6f1c1d1e-0000-4000-8000-000000000001", walletVerifiedAt: "2026-10-20T18:00:00.000Z" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
function complete() {
  fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Loco Scout" } });
  fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "scout" } });
  const file = new File([png], "scout.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => png.buffer });
  fireEvent.change(screen.getByLabelText(/Image \(PNG/), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("checkbox"));
}
const published = { ok: true, digest: "a".repeat(64), version: 1, uri: "https://studioloco.cfd/metadata", reused: false };
beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:token-preview");
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("metadata image upload and project links", () => {
  it("previews the image and submits normalized links with its uploaded bytes", async () => {
    const publish = vi.fn().mockResolvedValue(published), onPublished = vi.fn();
    render(<MetadataPublisher agent={agent} publish={publish as never} onPublished={onPublished} />);
    complete();
    fireEvent.change(screen.getByLabelText("Website (optional)"), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText("X profile (optional)"), { target: { value: "@Loco_Scout" } });
    expect(await screen.findByAltText("Selected token image preview")).toHaveAttribute("src", "blob:token-preview");
    expect(screen.getByRole("link", { name: /Website/ })).toHaveAttribute("href", "https://example.com/");
    expect(screen.getByRole("link", { name: /@Loco_Scout/ })).toHaveAttribute("href", "https://x.com/Loco_Scout");
    fireEvent.click(screen.getByRole("button", { name: "Publish immutable metadata" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(published.digest));
    expect(publish).toHaveBeenCalledWith({ data: expect.objectContaining({
      agentId: agent.id, name: "Loco Scout", symbol: "SCOUT", website: "https://example.com/", xUrl: "https://x.com/Loco_Scout",
      imageBase64: btoa(String.fromCharCode(...png)), imageMime: "image/png", confirmImmutable: true,
    }) });
  });
  it("blocks unsafe links and allows both optional fields to be cleared", async () => {
    const publish = vi.fn().mockResolvedValue(published);
    render(<MetadataPublisher agent={agent} publish={publish as never} onPublished={() => {}} />);
    complete();
    fireEvent.change(screen.getByLabelText("Website (optional)"), { target: { value: "javascript:alert(1)" } });
    fireEvent.change(screen.getByLabelText("X profile (optional)"), { target: { value: "https://example.com/loco" } });
    expect(screen.getByRole("button", { name: "Publish immutable metadata" })).toBeDisabled();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Website (optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("X profile (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish immutable metadata" }));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish.mock.calls[0]![0].data).not.toHaveProperty("website");
    expect(publish.mock.calls[0]![0].data).not.toHaveProperty("xUrl");
  });
  it("requires controller proof and refuses oversized images", () => {
    const publish = vi.fn();
    const view = render(<MetadataPublisher agent={{ ...agent, walletVerifiedAt: null }} publish={publish as never} onPublished={() => {}} />);
    complete();
    expect(screen.getByRole("button", { name: "Publish immutable metadata" })).toBeDisabled();
    view.rerender(<MetadataPublisher agent={agent} publish={publish as never} onPublished={() => {}} />);
    expect(screen.getByRole("button", { name: "Publish immutable metadata" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Image \(PNG/), { target: { files: [new File([new Uint8Array(262_145)], "large.png", { type: "image/png" })] } });
    expect(screen.getByRole("button", { name: "Publish immutable metadata" })).toBeDisabled();
    expect(screen.queryByAltText("Selected token image preview")).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
});
