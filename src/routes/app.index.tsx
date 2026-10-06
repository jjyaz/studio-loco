import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { Btn, Cap, Field, Notice, PageHead, Spinner } from "@/components/kit";
import { fetchPools, SORT_KEYS, SORT_LABELS, v24, type ApiPool, type SortKey } from "@/lib/meteora-api";
import { practicePage } from "@/lib/practice-data";
import { DASH, fmtPct, fmtUsd, isBase58Address, timeAgo } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { useSettings, useStars } from "@/lib/settings";
import { cn } from "@/lib/utils";

const search = z.object({
  q: z.string().optional().catch(undefined),
  sort: z.enum(SORT_KEYS).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  starred: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/app/")({
  validateSearch: zodValidator(search),
  head: () => ({
    meta: [
      { title: "Liquidity Terminal — Studio Loco" },
      { name: "description", content: "Live Meteora DLMM pools on Solana: search, sort by TVL, volume, fees, fee/TVL and bin step." },
      { property: "og:title", content: "Liquidity Terminal — Studio Loco" },
      { property: "og:description", content: "Live Meteora DLMM pool terminal with real data and wallet-signed actions." },
    ],
  }),
  component: Terminal,
});

const PAGE_SIZE = 20;

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Terminal() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: "/app/" });
  const { settings, update } = useSettings();
  const stars = useStars();
  const [text, setText] = useState(s.q ?? "");
  const q = useDebounced(text);
  const sort: SortKey = s.sort ?? "tvl";
  const dir = s.dir ?? "desc";
  const page = s.page ?? 1;
  const [hideBlack, setHideBlack] = useState(true);

  useEffect(() => {
    if ((s.q ?? "") !== q) navigate({ to: ".", search: (p) => ({ ...p, q: q || undefined, page: undefined }), replace: true });
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const devnet = settings.cluster === "devnet";
  const query = useQuery({
    queryKey: ["pools", settings.practice, q, sort, dir, page, hideBlack],
    queryFn: ({ signal }) => {
      const pq = { page, pageSize: PAGE_SIZE, query: q, sort, dir, hideBlacklisted: hideBlack };
      return settings.practice ? Promise.resolve(practicePage(pq)) : fetchPools(pq, signal);
    },
    enabled: !devnet || settings.practice,
    placeholderData: keepPreviousData,
    refetchInterval: settings.practice ? false : 60_000,
    retry: false,
  });

  const setSort = (k: SortKey) =>
    navigate({ to: ".", search: (p) => ({ ...p, sort: k, dir: sort === k && dir === "desc" ? "asc" : "desc", page: undefined }) });

  const rows = (query.data?.data ?? []).filter((p) => !s.starred || stars.isStarred(p.address));
  const directAddr = isBase58Address(text) ? text.trim() : null;

  return (
    <div>
      <PageHead code="ST-01 · Liquidity Terminal" title="Every station on the line." intro="Meteora DLMM pools with live public data. Open a pool to see its real bins, swap directly, or add liquidity from your wallet." cap={[settings.practice ? "practice" : "live"]}>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <span className="station-code text-cream/70">
            {settings.practice ? "Practice data · static" : query.dataUpdatedAt ? `Updated ${timeAgo(query.dataUpdatedAt)}` : DASH}
          </span>
          <Btn size="sm" variant="line" onClick={() => query.refetch()} disabled={query.isFetching || (devnet && !settings.practice)}>
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </Btn>
        </div>
      </PageHead>

      <div className="mb-5 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
        <Field label="Search pools" placeholder="Symbol, name or pool address" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="flex min-h-11 items-center gap-2 border border-line px-3 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--amber)]" checked={hideBlack} onChange={(e) => setHideBlack(e.target.checked)} />
          Hide blacklisted
        </label>
        <label className="flex min-h-11 items-center gap-2 border border-line px-3 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--amber)]" checked={!!s.starred} onChange={(e) => navigate({ to: ".", search: (p) => ({ ...p, starred: e.target.checked || undefined }) })} />
          Starred only ({stars.stars.length})
        </label>
      </div>

      {directAddr && !settings.practice && (
        <div className="mb-4">
          <Link to="/app/pool/$address" params={{ address: directAddr }} className="station-code text-amber underline">
            Open {directAddr.slice(0, 8)}… directly →
          </Link>
        </div>
      )}

      {devnet && !settings.practice && (
        <Notice tone="warn" title="Devnet selected">
          Meteora's public pool list covers mainnet only, so no list is shown on devnet rather than mislabelling mainnet data. Paste a devnet pool address above to open it, or switch to mainnet in Settings.
        </Notice>
      )}

      {query.isError && (
        <Notice
          tone="error"
          title="Couldn't load live pools"
          action={
            <div className="flex gap-2">
              <Btn size="sm" onClick={() => query.refetch()}>Retry</Btn>
              <Btn size="sm" variant="line" onClick={() => update({ practice: true })}>Use Practice mode</Btn>
            </div>
          }
        >
          {redactUrls(String(((query.error) as Error)?.message ?? ""))}. No substitute data is shown.
        </Notice>
      )}

      {query.isPending && !(devnet && !settings.practice) && <div className="py-10"><Spinner label="Fetching pools" /></div>}

      {query.data && (
        <>
          {sort === "fee_tvl_ratio_24h" && (
            <p className="mb-2 text-xs text-cream/70">Fee/TVL is 24h fees ÷ TVL, shown as a percent as reported by Meteora. Pools with almost no liquidity can show enormous ratios — check TVL before reading anything into it.</p>
          )}

          <div className="overflow-x-auto border border-line">
            <table className="w-full min-w-[860px] text-sm">
              <caption className="sr-only">DLMM pools</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="w-10 p-3"><span className="sr-only">Star</span></th>
                  <th scope="col" className="station-code p-3 text-cream/70">Pool</th>
                  {SORT_KEYS.map((k) => (
                    <th key={k} scope="col" className="p-3 text-right" aria-sort={sort === k ? (dir === "desc" ? "descending" : "ascending") : "none"}>
                      <button type="button" onClick={() => setSort(k)} className={cn("station-code min-h-9 hover:text-amber", sort === k ? "text-amber" : "text-cream/70")}>
                        {SORT_LABELS[k]} {sort === k ? (dir === "desc" ? "↓" : "↑") : ""}
                      </button>
                    </th>
                  ))}
                  <th scope="col" className="station-code p-3 text-right text-cream/70">Fee base / dyn</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => <PoolRow key={p.address} p={p} practice={settings.practice} starred={stars.isStarred(p.address)} onStar={() => stars.toggle(p.address)} />)}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-cream/70">{s.starred ? "No starred pools on this page." : "No pools match this search."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="station-code text-cream/70">
              Page {query.data.current_page} of {query.data.pages.toLocaleString()} · {query.data.total.toLocaleString()} pools
            </span>
            <div className="flex gap-2">
              <Btn size="sm" variant="line" disabled={page <= 1} onClick={() => navigate({ to: ".", search: (p) => ({ ...p, page: page - 1 }) })}>← Prev</Btn>
              <Btn size="sm" variant="line" disabled={page >= query.data.pages} onClick={() => navigate({ to: ".", search: (p) => ({ ...p, page: page + 1 }) })}>Next →</Btn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PoolRow({ p, practice, starred, onStar }: { p: ApiPool; practice: boolean; starred: boolean; onStar: () => void }) {
  const name = p.name ?? `${p.token_x?.symbol ?? DASH}-${p.token_y?.symbol ?? DASH}`;
  return (
    <tr className="border-b border-line/60 hover:bg-muted">
      <td className="p-3">
        <button type="button" onClick={onStar} aria-pressed={starred} aria-label={starred ? `Unstar ${name}` : `Star ${name}`} className={cn("grid size-9 place-items-center", starred ? "text-amber" : "text-cream/40 hover:text-cream")}>
          {starred ? "★" : "☆"}
        </button>
      </td>
      <td className="p-3">
        {practice ? (
          <span className="flex items-center gap-2 font-medium">{name} <Cap kind="practice" /></span>
        ) : (
          <Link to="/app/pool/$address" params={{ address: p.address }} className="font-medium text-cream hover:text-amber">
            {name}
          </Link>
        )}
        <div className="mt-1 flex gap-2 station-code text-[0.62rem] text-cream/55">
          <span>{p.address.slice(0, 6)}…</span>
          {p.is_blacklisted && <span className="text-destructive">Blacklisted</span>}
          {p.token_x?.is_verified === false && <span className="text-amber">Unverified X</span>}
          {p.token_y?.is_verified === false && <span className="text-amber">Unverified Y</span>}
        </div>
      </td>
      <td className="p-3 text-right font-mono tabular">{fmtUsd(p.tvl)}</td>
      <td className="p-3 text-right font-mono tabular">{fmtUsd(v24(p.volume))}</td>
      <td className="p-3 text-right font-mono tabular">{fmtUsd(v24(p.fees))}</td>
      <td className="p-3 text-right font-mono tabular">{fmtPct(v24(p.fee_tvl_ratio), 4)}</td>
      <td className="p-3 text-right font-mono tabular">{p.pool_config?.bin_step ?? DASH}</td>
      <td className="p-3 text-right font-mono tabular">{fmtPct(p.pool_config?.base_fee_pct)} / {fmtPct(p.dynamic_fee_pct)}</td>
    </tr>
  );
}
