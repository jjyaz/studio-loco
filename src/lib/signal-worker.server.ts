/**
 * Scheduled Signal Box tick (server-only). Called by pg_cron through /api/public/hooks/signal-tick.
 * - single global lease: overlapping ticks exit immediately
 * - bounded: ≤ MAX_WATCHES_PER_TICK watches, per-read timeouts, overall deadline
 * - each result commits through signal_commit(), which re-checks revision/status/expiry under a
 *   row lock, so pause/edit/delete during a tick discards that tick's result
 * - alerts are deduped by a unique key; pushes go only to the alert owner's subscriptions
 * Read-only: no transaction is ever built for signing, and no key material exists here.
 */
import { installNodeGlobals } from "./polyfills";
import { MAX_WATCHES_PER_TICK, ARB_MIN_INTERVAL_MS, StoredPositionRule, arbTick, failedTick, parseArbConfig, positionTick, type TickOutcome } from "./signal-box";
import type { OutRun } from "./agents";

const PUBLICNODE = "https://solana-rpc.publicnode.com";
const TICK_DEADLINE_MS = 100_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}
const redact = (s: string) => s.replace(/https?:\/\/[^\s"')]+/g, "[url]").slice(0, 300);

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

interface WatchRow { id: string; user_id: string; kind: string; position: string | null; pool: string | null; owner: string | null; rule: unknown; revision: number; out_run: unknown; last_proposed: unknown; last_run_at: string | null }

export async function runTick(admin: Admin): Promise<{ skipped?: string; tick?: number; processed: number; errors: number; alerts: number; discarded: number }> {
  installNodeGlobals();
  const holder = crypto.randomUUID();
  const { data: got, error: le } = await admin.rpc("signal_acquire_lease", { _holder: holder, _ttl_seconds: 150 });
  if (le) throw new Error(`lease: ${le.message}`);
  if (!got) return { skipped: "another tick holds the lease", processed: 0, errors: 0, alerts: 0, discarded: 0 };
  const { data: tickRow } = await admin.from("signal_ticks").insert({}).select("id").single();
  const tick = tickRow?.id ?? null;
  let processed = 0, errors = 0, alerts = 0, discarded = 0;
  const started = Date.now();
  try {
    const { data: watches, error } = await admin.from("signal_watches")
      .select("id,user_id,kind,position,pool,owner,rule,revision,out_run,last_proposed,last_run_at")
      .eq("status", "active").gt("expires_at", new Date().toISOString())
      .order("last_run_at", { ascending: true, nullsFirst: true }).limit(MAX_WATCHES_PER_TICK);
    if (error) throw new Error(error.message);
    const { Connection } = await import("@solana/web3.js");
    const rpc = process.env["SOLANA_MAINNET_RPC_URL"] || PUBLICNODE;
    const connection = new Connection(rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
    for (const w of (watches ?? []) as WatchRow[]) {
      if (Date.now() - started > TICK_DEADLINE_MS) break;
      if (w.kind === "arb" && w.last_run_at && Date.now() - Date.parse(w.last_run_at) < ARB_MIN_INTERVAL_MS) continue;
      const lastProposed = (w.last_proposed && typeof w.last_proposed === "object" ? w.last_proposed : {}) as Record<string, number>;
      let out: TickOutcome;
      try {
        out = w.kind === "position" ? await positionWatch(connection, w, lastProposed) : await arbWatch(connection, w, lastProposed);
      } catch (e) {
        out = failedTick(redact(e instanceof Error ? e.message : String(e)), lastProposed);
      }
      processed++;
      if (!out.ok) errors++;
      const { data: res, error: ce } = await admin.rpc("signal_commit", {
        _watch: w.id, _revision: w.revision, _tick: tick as number, _ok: out.ok, _summary: out.summary as never, _error: out.error as string,
        _out_run: out.outRun as never, _last_proposed: out.lastProposed as never, _alert: out.alert as never,
      });
      if (ce) { errors++; continue; }
      const r = res as { committed: boolean; alert_id?: string | null };
      if (!r.committed) { discarded++; continue; }
      if (r.alert_id) { alerts++; await notify(admin, w, r.alert_id, out.alert!); }
    }
    return { tick: tick ?? undefined, processed, errors, alerts, discarded };
  } finally {
    if (tick !== null) await admin.from("signal_ticks").update({ finished_at: new Date().toISOString(), processed, errors, alerts, note: discarded ? `${discarded} result(s) discarded after pause/edit/delete` : null }).eq("id", tick);
    await admin.rpc("signal_release_lease", { _holder: holder });
  }
}

async function positionWatch(connection: import("@solana/web3.js").Connection, w: WatchRow, lastProposed: Record<string, number>): Promise<TickOutcome> {
  const stored = StoredPositionRule.safeParse(w.rule);
  if (!stored.success || !w.position || !w.pool || !w.owner) return failedTick("Stored rule failed validation.", lastProposed);
  const obs = await observePosition(connection, w.position, w.pool, w.owner, stored.data.rule.volatility);
  const prevOut = (w.out_run && typeof w.out_run === "object" ? w.out_run : null) as OutRun | null;
  return positionTick({ watchId: w.id, revision: w.revision, position: w.position, pool: w.pool, owner: w.owner, stored: stored.data, obs, prevOut, lastProposed, now: Date.now() });
}

/** Fresh verified chain read: DLMM program owner, PositionV2 discriminator, pool + owner binding, live active bin. */
export async function observePosition(connection: import("@solana/web3.js").Connection, position: string, poolAddr: string, owner: string, vol: StoredPositionRule["rule"]["volatility"]) {
  const { PublicKey } = await import("@solana/web3.js");
  const { loadSdk, getPool, DLMM_PROGRAM_ID, invalidatePool } = await import("./dlmm");
  const { verifyDlmmAccount } = await import("./account-verify");
  const sdk = await loadSdk();
  const disc = Uint8Array.from(sdk.getAccountDiscriminator("positionV2"));
  invalidatePool(poolAddr);
  const pool = await withTimeout(getPool(connection, poolAddr, "mainnet-beta"), 20_000, "Pool load");
  const pk = new PublicKey(position);
  const info = await withTimeout(connection.getAccountInfo(pk, "confirmed"), 10_000, "Position read");
  if (!verifyDlmmAccount(info, { programId: DLMM_PROGRAM_ID, discriminator: disc, lbPair: pool.pubkey.toBytes(), owner: new PublicKey(owner).toBytes() })) {
    throw new Error("Position failed on-chain verification (program, PositionV2 type, pool or owner mismatch, or closed).");
  }
  const pos = await withTimeout(pool.getPosition(pk), 20_000, "Position decode");
  let volReading = null;
  if (vol) {
    const { readVolatility } = await import("./agents-chain");
    volReading = await readVolatility(poolAddr, "mainnet-beta", vol.frame, vol.candles);
  }
  return {
    activeId: pool.lbPair.activeId, binStep: pool.lbPair.binStep,
    lower: pos.positionData.lowerBinId, upper: pos.positionData.upperBinId,
    mintX: pool.tokenX.publicKey.toBase58(), mintY: pool.tokenY.publicKey.toBase58(),
    decX: pool.tokenX.mint.decimals, decY: pool.tokenY.mint.decimals,
    vol: volReading,
  };
}

async function arbWatch(connection: import("@solana/web3.js").Connection, w: WatchRow, lastProposed: Record<string, number>): Promise<TickOutcome> {
  const v = parseArbConfig(w.rule);
  if (!v.ok) return failedTick(`Stored config invalid: ${v.error}`, lastProposed);
  const { validateConfig } = await import("./arb-math");
  const chk = validateConfig(v.cfg);
  if (!chk.ok) return failedTick(chk.error, lastProposed);
  const { scanRoutes, readOnlyScanCosts } = await import("./arb");
  const costs = await readOnlyScanCosts(connection, chk.priorityBudget, chk.cfg.computeUnits);
  const r = await withTimeout(scanRoutes(connection, { inLamports: chk.inLamports, minProfit: chk.minProfit, slippageBps: chk.cfg.slippageBps, maxPools: chk.cfg.maxPools, costs }), 80_000, "Arb scan");
  const routes = r.routes.map((x) => ({
    poolA: x.a.pool, poolB: x.b?.pool ?? "", nameA: x.nameA, nameB: x.nameB, verdict: x.verdict.kind,
    expectedProfitLamports: x.verdict.kind === "profitable" ? x.verdict.expectedProfit.toString() : x.verdict.kind === "unprofitable" && x.verdict.expectedProfit ? x.verdict.expectedProfit.toString() : null,
  }));
  return arbTick({ watchId: w.id, revision: w.revision, routes, complete: r.complete, poolCount: r.pools.length, inputSol: chk.cfg.inputSol, lastProposed, now: Date.now() });
}

async function notify(admin: Admin, w: WatchRow, alertId: string, alert: NonNullable<TickOutcome["alert"]>) {
  const seed = process.env["VAPID_PRIVATE_SEED"];
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", w.user_id).limit(5);
  if (!seed || !subs?.length) { await admin.from("signal_alerts").update({ push_status: subs?.length ? "push unavailable" : "inbox only" }).eq("id", alertId); return; }
  const { sendPush } = await import("./webpush.server");
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await sendPush(s, { title: "Signal Box", body: alert.reason.slice(0, 180), alert: alertId, url: `/app/signal-box?alert=${alertId}` }, seed);
      if (r.ok) { sent++; await admin.from("push_subscriptions").update({ last_ok_at: new Date().toISOString(), last_error: null }).eq("id", s.id); }
      else if (r.gone) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else await admin.from("push_subscriptions").update({ last_error: `HTTP ${r.status}` }).eq("id", s.id);
    } catch (e) {
      await admin.from("push_subscriptions").update({ last_error: redact(e instanceof Error ? e.message : String(e)) }).eq("id", s.id);
    }
  }
  await admin.from("signal_alerts").update({ push_status: `push sent to ${sent}/${subs.length}` }).eq("id", alertId);
}
