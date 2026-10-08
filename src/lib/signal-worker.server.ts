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
import {
  MAX_WATCHES_PER_TICK,
  ARB_MIN_INTERVAL_MS,
  StoredPositionRule,
  arbTick,
  failedTick,
  parseArbConfig,
  positionTick,
  type TickOutcome,
} from "./signal-box";
import type { OutRun } from "./agents";

const PUBLICNODE = "https://solana-rpc.publicnode.com";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}
const redact = (s: string) => s.replace(/https?:\/\/[^\s"')]+/g, "[url]").slice(0, 300);

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

export interface WatchRow {
  id: string;
  user_id: string;
  kind: string;
  position: string | null;
  pool: string | null;
  owner: string | null;
  rule: unknown;
  revision: number;
  out_run: unknown;
  last_proposed: unknown;
  last_run_at: string | null;
}

const LEASE_TTL_S = 150;
/** Work stops well before the lease can expire; the DB also refuses commits once it has. */
export const TICK_BUDGET_MS = 110_000;
const MIN_WATCH_BUDGET_MS = 15_000;
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function rpcSource(): "server-configured" | "publicnode-default" {
  return process.env["SOLANA_MAINNET_RPC_URL"] ? "server-configured" : "publicnode-default";
}
export async function mainnetConnection() {
  const { Connection } = await import("@solana/web3.js");
  const { createRpcFetch } = await import("./rpc-fetch");
  return new Connection(process.env["SOLANA_MAINNET_RPC_URL"] || PUBLICNODE, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: createRpcFetch(fetch, 15_000),
  });
}

export interface TickDeps {
  connection?: import("@solana/web3.js").Connection;
  now?: () => number;
  budgetMs?: number;
  observe?: (
    w: WatchRow,
    lastProposed: Record<string, number>,
    budgetMs: number,
  ) => Promise<TickOutcome>;
}

export async function runTick(
  admin: Admin,
  deps: TickDeps = {},
): Promise<{
  skipped?: string;
  tick?: number;
  processed: number;
  errors: number;
  alerts: number;
  discarded: number;
  late: number;
}> {
  installNodeGlobals();
  const now = deps.now ?? Date.now;
  const holder = crypto.randomUUID();
  const { data: got, error: le } = await admin.rpc("signal_acquire_lease", {
    _holder: holder,
    _ttl_seconds: LEASE_TTL_S,
  });
  if (le) throw new Error(`lease: ${le.message}`);
  if (!got)
    return {
      skipped: "another tick holds the lease",
      processed: 0,
      errors: 0,
      alerts: 0,
      discarded: 0,
      late: 0,
    };
  const started = now();
  const deadline = started + (deps.budgetMs ?? TICK_BUDGET_MS);
  const bounded = <T>(p: PromiseLike<T>, what: string, cap = 10_000) =>
    withTimeout(Promise.resolve(p), Math.max(1, Math.min(cap, deadline - now())), what);
  let tick: number | null = null;
  let processed = 0,
    errors = 0,
    alerts = 0,
    discarded = 0,
    late = 0;
  let note: string | null = null;
  try {
    const { data: tickRow, error: te } = await bounded(
      admin.from("signal_ticks").insert({}).select("id").single(),
      "Tick persistence",
    );
    if (te || !tickRow) {
      note = "tick row unavailable";
      errors++;
    } else tick = tickRow.id;
    const { data: watches, error } = await bounded(
      admin
        .from("signal_watches")
        .select(
          "id,user_id,kind,position,pool,owner,rule,revision,out_run,last_proposed,last_run_at",
        )
        .eq("status", "active")
        .gt("expires_at", new Date(now()).toISOString())
        .order("last_run_at", { ascending: true, nullsFirst: true })
        .limit(MAX_WATCHES_PER_TICK),
      "Watch discovery",
    );
    if (error) throw new Error(error.message);
    const connection = deps.connection ?? (watches?.length ? await mainnetConnection() : null);
    for (const w of (watches ?? []) as WatchRow[]) {
      const remaining = deadline - now();
      if (remaining < MIN_WATCH_BUDGET_MS) break;
      if (
        w.kind === "arb" &&
        w.last_run_at &&
        now() - Date.parse(w.last_run_at) < ARB_MIN_INTERVAL_MS
      )
        continue;
      const lastProposed = (
        w.last_proposed && typeof w.last_proposed === "object" ? w.last_proposed : {}
      ) as Record<string, number>;
      const budget = remaining - 5_000;
      let out: TickOutcome;
      try {
        const work = deps.observe
          ? deps.observe(w, lastProposed, budget)
          : w.kind === "position"
            ? positionWatch(connection!, w, lastProposed, budget)
            : arbWatch(connection!, w, lastProposed, budget);
        out = await withTimeout(work, budget, "Observation");
      } catch (e) {
        out = failedTick(redact(e instanceof Error ? e.message : String(e)), lastProposed);
      }
      processed++;
      // No late results: past the deadline the result is dropped, not committed.
      if (now() > deadline) {
        late++;
        break;
      }
      if (!out.ok) errors++;
      const { data: res, error: ce } = await bounded(
        admin.rpc("signal_commit", {
          _holder: holder,
          _watch: w.id,
          _revision: w.revision,
          _tick: tick as number,
          _ok: out.ok,
          _summary: out.summary as never,
          _error: out.error as string,
          _out_run: out.outRun as never,
          _last_proposed: out.lastProposed as never,
          _alert: out.alert as never,
        }),
        "Observation persistence",
      );
      if (ce) {
        errors++;
        continue;
      }
      const r = res as { committed: boolean; reason?: string; alert_id?: string | null };
      if (!r.committed) {
        discarded++;
        if (r.reason === "lease lost") {
          note = "lease lost; tick stopped";
          break;
        }
        continue;
      }
      if (r.alert_id) {
        alerts++;
        try {
          await bounded(
            notify(admin, w, r.alert_id, out.alert!, deadline),
            "Notifications",
            Math.max(1, deadline - now()),
          );
        } catch {
          note = "notification delivery unavailable; alert retained in inbox";
        }
      }
    }
    return { tick: tick ?? undefined, processed, errors, alerts, discarded, late };
  } catch (e) {
    errors++;
    note = redact(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    const notes =
      [
        note,
        discarded ? `${discarded} result(s) discarded (pause/edit/delete/expiry/lease)` : null,
        late ? "deadline reached; late result dropped" : null,
      ]
        .filter(Boolean)
        .join("; ") || null;
    try {
      if (tick !== null)
        await withTimeout(
          Promise.resolve(
            admin
              .from("signal_ticks")
              .update({
                finished_at: new Date(now()).toISOString(),
                processed,
                errors,
                alerts,
                note: notes,
              })
              .eq("id", tick),
          ),
          5_000,
          "Tick completion",
        ).catch(() => undefined);
    } finally {
      await withTimeout(
        Promise.resolve(admin.rpc("signal_release_lease", { _holder: holder })),
        5_000,
        "Lease release",
      ).catch(() => undefined);
    }
  }
}

async function positionWatch(
  connection: import("@solana/web3.js").Connection,
  w: WatchRow,
  lastProposed: Record<string, number>,
  budgetMs: number,
): Promise<TickOutcome> {
  const stored = StoredPositionRule.safeParse(w.rule);
  if (!stored.success || !w.position || !w.pool || !w.owner)
    return failedTick("Stored rule failed validation.", lastProposed);
  const obs = await observePosition(
    connection,
    w.position,
    w.pool,
    w.owner,
    stored.data.rule.volatility,
    { mintX: stored.data.mintX, mintY: stored.data.mintY, binStep: stored.data.binStep },
    budgetMs,
  );
  const prevOut = (w.out_run && typeof w.out_run === "object" ? w.out_run : null) as OutRun | null;
  const t = positionTick({
    watchId: w.id,
    revision: w.revision,
    position: w.position,
    pool: w.pool,
    owner: w.owner,
    stored: stored.data,
    obs,
    prevOut,
    lastProposed,
    now: Date.now(),
  });
  if (t.ok)
    t.summary = {
      ...t.summary,
      slot: obs.slot,
      source: obs.source,
      genesis: "verified",
      decX: obs.decX,
      decY: obs.decY,
    };
  return t;
}

/** Fresh verified chain read: genesis, pool program/discriminator, PositionV2 program/discriminator/pool/owner,
 *  token mint programs/decimals, optional stored identities. Any failure throws → observation unavailable. */
export async function observePosition(
  connection: import("@solana/web3.js").Connection,
  position: string,
  poolAddr: string,
  owner: string,
  vol: StoredPositionRule["rule"]["volatility"],
  expect: { mintX: string; mintY: string; binStep?: number } | null = null,
  budgetMs = 60_000,
) {
  const end = Date.now() + budgetMs;
  const left = (cap: number) => Math.max(1, Math.min(cap, end - Date.now()));
  const { PublicKey } = await import("@solana/web3.js");
  const { loadSdk, getPool, DLMM_PROGRAM_ID, invalidatePool } = await import("./dlmm");
  const { verifyDlmmAccount } = await import("./account-verify");
  const genesis = await withTimeout(connection.getGenesisHash(), left(10_000), "Genesis read");
  if (genesis !== MAINNET_GENESIS) throw new Error("RPC is not mainnet-beta (genesis mismatch).");
  const sdk = await loadSdk();
  const posDisc = Uint8Array.from(sdk.getAccountDiscriminator("positionV2"));
  const pairDisc = Uint8Array.from(sdk.getAccountDiscriminator("lbPair"));
  const poolPk = new PublicKey(poolAddr),
    pk = new PublicKey(position);
  const raw = await withTimeout(
    connection.getMultipleAccountsInfoAndContext([poolPk, pk], "confirmed"),
    left(15_000),
    "Account read",
  );
  const [poolInfo, posInfo] = raw.value;
  if (
    !poolInfo ||
    poolInfo.owner.toBase58() !== DLMM_PROGRAM_ID ||
    !Buffer.from(poolInfo.data.subarray(0, 8)).equals(Buffer.from(pairDisc))
  ) {
    throw new Error("Pool failed on-chain verification (not a DLMM LbPair).");
  }
  if (
    !verifyDlmmAccount(posInfo, {
      programId: DLMM_PROGRAM_ID,
      discriminator: posDisc,
      lbPair: poolPk.toBytes(),
      owner: new PublicKey(owner).toBytes(),
    })
  ) {
    throw new Error(
      "Position failed on-chain verification (program, PositionV2 type, pool or owner mismatch, or closed).",
    );
  }
  invalidatePool(poolAddr);
  const pool = await withTimeout(
    getPool(connection, poolAddr, "mainnet-beta"),
    left(20_000),
    "Pool load",
  );
  // The reported active bin and position bounds belong to the SAME confirmed RPC context.
  const pairState = pool.program.coder.accounts.decode(
    "lbPair",
    Buffer.from(poolInfo.data),
  ) as typeof pool.lbPair;
  const posState = pool.program.coder.accounts.decode("positionV2", Buffer.from(posInfo!.data)) as {
    lowerBinId: number;
    upperBinId: number;
  };
  const mintX = pool.tokenX.publicKey.toBase58(),
    mintY = pool.tokenY.publicKey.toBase58();
  if (expect && (expect.mintX !== mintX || expect.mintY !== mintY))
    throw new Error("Pool mint identity no longer matches the watched pair.");
  if (pairState.tokenXMint.toBase58() !== mintX || pairState.tokenYMint.toBase58() !== mintY)
    throw new Error("Pool snapshot mint identity changed.");
  if (expect?.binStep !== undefined && expect.binStep !== pairState.binStep)
    throw new Error("Pool bin step changed.");
  const mints = await withTimeout(
    connection.getMultipleAccountsInfo([pool.tokenX.publicKey, pool.tokenY.publicKey], "confirmed"),
    left(10_000),
    "Mint read",
  );
  const decs = [pool.tokenX.mint.decimals, pool.tokenY.mint.decimals];
  mints.forEach((m, i) => {
    if (
      !m ||
      !TOKEN_PROGRAMS.has(m.owner.toBase58()) ||
      m.data.length < 82 ||
      m.data[44] !== decs[i]
    )
      throw new Error("Token mint failed verification (program or decimals).");
  });
  let volReading = null;
  if (vol) {
    const { readVolatility } = await import("./agents-chain");
    volReading = await withTimeout(
      readVolatility(poolAddr, "mainnet-beta", vol.frame, vol.candles),
      left(15_000),
      "Volatility read",
    );
  }
  return {
    activeId: pairState.activeId,
    binStep: pairState.binStep,
    lower: posState.lowerBinId,
    upper: posState.upperBinId,
    mintX,
    mintY,
    decX: decs[0]!,
    decY: decs[1]!,
    vol: volReading,
    slot: raw.context.slot,
    source: rpcSource(),
  };
}

async function arbWatch(
  connection: import("@solana/web3.js").Connection,
  w: WatchRow,
  lastProposed: Record<string, number>,
  budgetMs: number,
): Promise<TickOutcome> {
  const genesis = await withTimeout(
    connection.getGenesisHash(),
    Math.min(10_000, budgetMs),
    "Genesis read",
  );
  if (genesis !== MAINNET_GENESIS) throw new Error("RPC is not mainnet-beta (genesis mismatch).");
  const v = parseArbConfig(w.rule);
  if (!v.ok) return failedTick(`Stored config invalid: ${v.error}`, lastProposed);
  const { validateConfig } = await import("./arb-math");
  const chk = validateConfig(v.cfg);
  if (!chk.ok) return failedTick(chk.error, lastProposed);
  const { scanRoutes, readOnlyScanCosts } = await import("./arb");
  const costs = await readOnlyScanCosts(connection, chk.priorityBudget, chk.cfg.computeUnits);
  const r = await withTimeout(
    scanRoutes(connection, {
      inLamports: chk.inLamports,
      minProfit: chk.minProfit,
      slippageBps: chk.cfg.slippageBps,
      maxPools: chk.cfg.maxPools,
      costs,
    }),
    Math.max(1, Math.min(80_000, budgetMs - 10_000)),
    "Arb scan",
  );
  const routes = r.routes.map((x) => ({
    poolA: x.a.pool,
    poolB: x.b?.pool ?? "",
    nameA: x.nameA,
    nameB: x.nameB,
    verdict: x.verdict.kind,
    expectedProfitLamports:
      x.verdict.kind === "profitable"
        ? x.verdict.expectedProfit.toString()
        : x.verdict.kind === "unprofitable" && x.verdict.expectedProfit
          ? x.verdict.expectedProfit.toString()
          : null,
  }));
  const t = arbTick({
    watchId: w.id,
    revision: w.revision,
    routes,
    complete: r.complete,
    poolCount: r.pools.length,
    inputSol: chk.cfg.inputSol,
    lastProposed,
    now: Date.now(),
  });
  if (t.ok) t.summary = { ...t.summary, source: rpcSource(), genesis: "verified" };
  return t;
}

async function notify(
  admin: Admin,
  w: WatchRow,
  alertId: string,
  alert: NonNullable<TickOutcome["alert"]>,
  deadline: number,
) {
  const { sendPush, loadVapidSeed } = await import("./webpush.server");
  const seed = await loadVapidSeed();
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("user_id", w.user_id)
    .limit(5);
  if (!seed || !subs?.length) {
    await admin
      .from("signal_alerts")
      .update({ push_status: subs?.length ? "push unavailable" : "inbox only" })
      .eq("id", alertId);
    return;
  }
  let sent = 0;
  for (const s of subs) {
    if (Date.now() >= deadline - 10_000) break;
    try {
      const r = await sendPush(
        s,
        { title: "Signal Box", body: alert.reason.slice(0, 180), alert: alertId },
        seed,
      );
      if (r.ok) {
        sent++;
        await admin
          .from("push_subscriptions")
          .update({ last_ok_at: new Date().toISOString(), last_error: null })
          .eq("id", s.id);
      } else if (r.gone)
        await admin.from("push_subscriptions").delete().eq("id", s.id).eq("user_id", w.user_id);
      else
        await admin
          .from("push_subscriptions")
          .update({ last_error: `HTTP ${r.status}` })
          .eq("id", s.id);
    } catch (e) {
      await admin
        .from("push_subscriptions")
        .update({ last_error: redact(e instanceof Error ? e.message : String(e)) })
        .eq("id", s.id);
    }
  }
  await admin
    .from("signal_alerts")
    .update({
      push_status: `push accepted by provider for ${sent}/${subs.length} device(s); delivery not confirmed`,
    })
    .eq("id", alertId);
}
