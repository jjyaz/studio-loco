import { useEffect, useState } from "react";
import { Btn, Field, Notice, Panel } from "@/components/kit";
import { IMAGE_MIMES, MAX_IMAGE_BYTES, MetadataWebsite, MetadataXProfile, type AgentDTO } from "@/lib/depot-contracts";
import { recordFact } from "@/lib/recorder-store";
import type { publishTokenMetadata } from "@/lib/depot.functions";
import type { useDepotServerFn } from "./auth";

type Props = {
  agent: Pick<AgentDTO, "id" | "walletVerifiedAt">;
  publish: ReturnType<typeof useDepotServerFn<typeof publishTokenMetadata>>;
  onPublished: (digest: string) => void;
};

export function MetadataPublisher({ agent, publish, onPublished }: Props) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [xProfile, setXProfile] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (!file || !(IMAGE_MIMES as readonly string[]).includes(file.type) || !file.size || file.size > MAX_IMAGE_BYTES) {
      setPreview(null); return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const parsedWebsite = website.trim() ? MetadataWebsite.safeParse(website) : null;
  const parsedX = xProfile.trim() ? MetadataXProfile.safeParse(xProfile) : null;
  const websiteUrl = parsedWebsite?.success ? parsedWebsite.data : undefined;
  const xUrl = parsedX?.success ? parsedX.data : undefined;
  const websiteError = parsedWebsite && !parsedWebsite.success ? parsedWebsite.error.issues[0]?.message : undefined;
  const xError = parsedX && !parsedX.success ? parsedX.error.issues[0]?.message : undefined;
  const nameBytes = new TextEncoder().encode(name.trim()).length;
  const errs = [
    !name.trim() || nameBytes > 32 ? `Name 1–32 bytes (${nameBytes})` : null,
    !/^[A-Z0-9]{1,10}$/.test(symbol) ? "Symbol 1–10 uppercase letters/digits" : null,
    description.trim().length > 500 ? "Description ≤ 500 characters" : null,
    !file || !file.size ? "Choose an image" : !(IMAGE_MIMES as readonly string[]).includes(file.type) ? "PNG, JPEG or WebP only" : file.size > MAX_IMAGE_BYTES ? "Image ≤ 256 KB" : null,
    websiteError, xError,
    !consent ? "Confirm immutability" : null,
  ].filter(Boolean) as string[];
  return (
    <Panel>
      <p className="station-code text-amber">Step 1 · Immutable token metadata</p>
      <p className="mt-2 text-sm text-cream/75">Upload your token image and add its website and X profile. Links are optional.</p>
      {!agent.walletVerifiedAt && <p className="mt-2 text-sm text-cream/75">Prove the controller wallet in Passport first.</p>}
      <form
        className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || errs.length || !file || !agent.walletVerifiedAt) return;
          setBusy(true); setMsg(null);
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            const r = await publish({ data: {
              agentId: agent.id, name, symbol, description,
              ...(websiteUrl ? { website: websiteUrl } : {}), ...(xUrl ? { xUrl } : {}),
              imageBase64: btoa(bin), imageMime: file.type as (typeof IMAGE_MIMES)[number], confirmImmutable: true,
            } });
            if (!r.ok) throw new Error(r.error);
            setMsg({ tone: "info", text: r.reused ? `Identical content already published as v${r.version}.` : `Published v${r.version}.` });
            void recordFact({ kind: "proposal", title: `Depot metadata v${r.version}`, route: "/app/depot", cluster: "mainnet-beta", context: { depotAgent: agent.id, metadataDigest: r.digest, metadataUri: r.uri } }).catch(() => {});
            onPublished(r.digest);
          } catch (error) {
            setMsg({ tone: "error", text: error instanceof Error ? error.message : String(error) });
          } finally { setBusy(false); }
        }}
      >
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          <Field label="Token name" value={name} onChange={(e) => setName(e.target.value)} hint={`${nameBytes}/32 bytes`} />
          <Field label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))} />
          <label className="flex flex-col gap-1.5">
            <span className="station-code text-cream/80">Description ({description.length}/500)</span>
            <textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} className="border border-input bg-midnight px-3 py-2 text-sm text-cream outline-none focus:border-amber" />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="station-code text-cream/80">Image (PNG/JPEG/WebP, ≤256 KB)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="max-w-full text-sm text-cream file:mr-3 file:border file:border-cream/60 file:bg-transparent file:px-3 file:py-2 file:text-cream" />
          </label>
          <Field label="Website (optional)" type="url" inputMode="url" autoComplete="url" maxLength={512} placeholder="https://your-project.com" value={website} onChange={(e) => setWebsite(e.target.value)} error={websiteError} hint="Included in the public token metadata." />
          <Field label="X profile (optional)" maxLength={256} placeholder="@your_project or https://x.com/your_project" value={xProfile} onChange={(e) => setXProfile(e.target.value)} error={xError} hint="A profile URL or @handle; published as an x.com link." />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 accent-amber" />
            <span>I understand these token details, image and any links become a permanent public file that cannot be edited or deleted. Changes create a new version.</span>
          </label>
        </fieldset>
        <div className="flex min-w-0 flex-col items-center gap-2">
          <div className="flex size-40 items-center justify-center border border-line bg-midnight">
            {preview ? <img src={preview} alt="Selected token image preview" className="size-full object-cover" /> : <span className="station-code text-cream/50">No image</span>}
          </div>
          <span className="station-code text-cream/60">Metadata preview</span>
          {websiteUrl && <a href={websiteUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-amber underline underline-offset-4">Website ↗</a>}
          {xUrl && <a href={xUrl} target="_blank" rel="noopener noreferrer" className="max-w-full break-all text-sm text-amber underline underline-offset-4">@{xUrl.split("/").pop()} ↗</a>}
        </div>
        <div className="md:col-span-2 flex flex-col gap-2">
          {errs.length > 0 && <p className="text-xs text-cream/65">{errs.join(" · ")}</p>}
          <Btn type="submit" disabled={busy || errs.length > 0 || !agent.walletVerifiedAt}>{busy ? "Publishing…" : "Publish immutable metadata"}</Btn>
          <p className="text-xs text-cream/60">Free to publish; no onchain cost until launch. Published images and metadata are hosted on studioloco.cfd. Up to 20 versions/hour and 100 permanent versions/account.</p>
          {msg && <Notice tone={msg.tone} title={msg.text} />}
        </div>
      </form>
    </Panel>
  );
}
