/** Explicit production acceptance. Two fresh unfunded keys, offchain signatures only. No token launch or transaction. */
import { randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { fromJSON, toJSONAsync } from "seroval";

const base = "https://studioloco.cfd", dir = new URL("../../.output/server/_ssr/", import.meta.url);
const ids = {};
for (const f of await readdir(dir)) if (f.startsWith("depot.functions-") && f.endsWith(".mjs")) {
  const text = await readFile(new URL(f, dir), "utf8");
  if (!text.includes("requireDepotWalletAuth")) continue;
  for (const match of text.matchAll(/id:\s*"([a-f0-9]+)",\s*name:\s*"([A-Za-z]+)"/g)) ids[match[2]] = match[1];
}
for (const n of ["createAgent", "listMyAgents", "updateAgent", "deleteAgent"]) assert.ok(ids[n], `Build first: ${n} id missing`);
const wallets = [0, 1].map(() => { const key = new Uint8Array(randomBytes(32)); return { key, wallet: bs58.encode(ed25519.getPublicKey(key)), cookie: "", account: null, agent: null }; });
const checks = [], check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
async function auth(w, action, data, cookie = w.cookie, origin = base) {
  const r = await fetch(`${base}/api/public/depot/auth/${action}`, {
    method: data === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "x-loco-depot-wallet": w.wallet, origin, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0], body: await r.json() };
}
async function fn(w, name, data) {
  const r = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: data === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "x-loco-depot-wallet": w.wallet, cookie: w.cookie, origin: base, "x-tsr-serverFn": "true", accept: "application/json", ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(await toJSONAsync({ data })) }),
  });
  check("protected function response is not cacheable", r.headers.get("cache-control")?.includes("no-store"));
  const raw = await r.json(); const decoded = raw && typeof raw === "object" && "t" in raw ? fromJSON(raw) : raw;
  if (decoded.error) throw new Error(decoded.error.message ?? "Protected function refused");
  return decoded.result ?? decoded;
}
let failure;
try {
  for (const [i, w] of wallets.entries()) {
    const c = await auth(w, "challenge", { wallet: w.wallet });
    check(`wallet ${i}: challenge`, c.status === 200 && c.body.challenge.wallet === w.wallet && c.body.challenge.domain === "studioloco.cfd");
    const d = { wallet: w.wallet, nonce: c.body.challenge.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(c.body.message), w.key)) };
    const bad = await auth(w, "verify", { ...d, signature: bs58.encode(new Uint8Array(64)) });
    check(`wallet ${i}: invalid signature refused`, bad.status === 401 && !bad.cookie);
    const v = await auth(w, "verify", d); check(`wallet ${i}: real signature accepted`, v.status === 200 && !!v.cookie && v.body.account.wallet === w.wallet);
    w.cookie = v.cookie; w.account = v.body.account;
    check(`wallet ${i}: challenge replay refused`, (await auth(w, "verify", d)).status === 401);
    const s = await auth(w, "session"); check(`wallet ${i}: cookie session`, s.body.account?.id === w.account.id);
    const a = await fn(w, "createAgent", { name: `Wallet auth QA ${i}`, description: "Temporary private authentication acceptance fixture", mission: "scout" });
    check(`wallet ${i}: private agent created`, a.ok && a.agent.visibility === "private"); w.agent = a.agent;
  }
  const [a, b] = wallets;
  check("different wallets have distinct principals", a.account.id !== b.account.id);
  check("another wallet's cookie is not a login", !(await auth(b, "session", undefined, a.cookie)).body.account);
  check("cross-origin login refused", (await auth(a, "challenge", { wallet: a.wallet }, a.cookie, "https://evil.example")).status === 400);
  for (const [w, other] of [[a, b], [b, a]]) {
    const list = await fn(w, "listMyAgents"); check("only own private agent returned", list.ok && list.agents.some(x => x.id === w.agent.id) && !list.agents.some(x => x.id === other.agent.id));
    const edit = await fn(w, "updateAgent", { id: other.agent.id, revision: other.agent.revision, name: "forbidden" });
    check("foreign agent edit refused", edit.ok === false && /not found/i.test(edit.error));
  }
} catch (e) { failure = e instanceof Error ? e.message : "Acceptance failed"; }
finally {
  for (const w of wallets) {
    try {
      if (w.agent) check("private QA agent deleted", (await fn(w, "deleteAgent", { id: w.agent.id, revision: w.agent.revision })).ok);
      if (w.cookie) { check("session logged out", (await auth(w, "logout", {})).body.ok); check("revoked cookie rejected", !(await auth(w, "session")).body.account); }
    } catch (e) { failure ??= e instanceof Error ? e.message : "Cleanup failed"; }
    w.key.fill(0);
  }
}
const report = { checkedAt: new Date().toISOString(), base, checks, passed: !failure, ...(failure ? { failure } : {}), accounts: wallets.filter(w => w.account).map(w => ({ id: w.account.id, wallet: w.wallet })), financialSignatures: 0, broadcasts: 0 };
await writeFile(new URL("../../.qa/depot-wallet-production.json", import.meta.url), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2)+"\n");
if (failure) process.exitCode = 1;
