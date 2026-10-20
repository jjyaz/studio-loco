/** Wallet-reviewed Meteora adapters. Keypairs exist only in a prepared action's memory. */
import type { Connection, Signer, Transaction } from "@solana/web3.js";
import { installNodeGlobals } from "./polyfills";
import { assertCluster, withTimeout } from "./tx";
import { bindingKey, getPreset, launchMath, reviewGuard, validateMetadata, validateRecipients, WSOL_MINT, type PreparedReview, type ReviewBinding, type TokenMetadataDraft } from "./depot";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
let dbcImport: Promise<typeof import("@meteora-ag/dynamic-bonding-curve-sdk")> | undefined;
let dammImport: Promise<typeof import("@meteora-ag/cp-amm-sdk")> | undefined;
export function loadDepotDbc() {
  installNodeGlobals();
  if (!dbcImport) { const p = import("@meteora-ag/dynamic-bonding-curve-sdk"); dbcImport = p; void p.catch(() => { if (dbcImport === p) dbcImport = undefined; }); }
  return dbcImport;
}
export function loadDepotDamm() {
  installNodeGlobals();
  if (!dammImport) { const p = import("@meteora-ag/cp-amm-sdk"); dammImport = p; void p.catch(() => { if (dammImport === p) dammImport = undefined; }); }
  return dammImport;
}

export type DepotActionKind = "launch" | "migrate" | "claim-curve" | "claim-damm" | "reserve";
export interface DepotTarget { config: string; mint: string; pool: string; dammPool?: string }
export interface PreparedDepotAction {
  kind: DepotActionKind;
  label: string;
  target: DepotTarget;
  binding: ReviewBinding;
  review: PreparedReview;
  tx: Transaction;
  signers: Signer[];
  instructionKey: string;
  /** Digest of the public immutable metadata bytes; never a signed URL. */
  metadataHash?: string;
  observedSlot: number;
  notes: string[];
}

/** Blockhash may refresh in tx.ts; every instruction, account privilege and byte stays bound. */
export function depotInstructionKey(tx: Transaction): string {
  return JSON.stringify(tx.instructions.map(ix => [ix.programId.toBase58(), ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), Array.from(ix.data)]));
}

export function depotActionGuard(p: PreparedDepotAction, current: ReviewBinding, tx: Transaction, now = Date.now()): string | null {
  const reason = reviewGuard(p.review, current, now, p.binding);
  if (reason) return reason;
  if (depotInstructionKey(tx) !== p.instructionKey) return "Prepared instructions changed. Prepare again.";
  if (tx.feePayer && tx.feePayer.toBase58() !== current.wallet) return "Fee payer changed.";
  return null;
}

const bounded = <T>(p: Promise<T>, what: string) => withTimeout(p, 15_000, what);

/** Separately price the fee and newly allocated accounts; claim proceeds cannot hide rent. */
export async function depotCosts(connection: Connection, tx: Transaction, wallet: string) {
  const { VersionedTransaction, PublicKey } = await import("@solana/web3.js");
  if (tx.feePayer?.toBase58() !== wallet) throw new Error("Unexpected fee payer");
  const message = tx.compileMessage();
  const bytes = message.serialize().length + 1 + message.header.numRequiredSignatures * 64;
  if (bytes > 1232) throw new Error(`Launch transaction is ${bytes} bytes. Shorten the token name or metadata URI and prepare again.`);
  const addresses = [...new Set(tx.instructions.flatMap(i => i.keys.filter(k => k.isWritable).map(k => k.pubkey.toBase58())))].filter(k => k !== wallet);
  if (addresses.length > 40) throw new Error("Too many writable accounts to review safely");
  const [before, fee, simulation] = await Promise.all([
    bounded(connection.getMultipleAccountsInfo(addresses.map(a => new PublicKey(a)), "confirmed"), "Account costs"),
    bounded(connection.getFeeForMessage(message, "confirmed"), "Network fee"),
    bounded(connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { encoding: "base64", addresses } }), "Depot simulation"),
  ]);
  if (simulation.value.err) throw new Error(`Meteora simulation refused this action: ${JSON.stringify(simulation.value.err)}. ${simulation.value.logs?.slice(-3).join(" ") ?? ""}`);
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) throw new Error("Network fee unavailable");
  const after = simulation.value.accounts;
  if (!after || after.length !== addresses.length) throw new Error("Simulation did not return account cost evidence");
  let rent = 0n;
  for (let i = 0; i < addresses.length; i++) {
    const a = after[i];
    if (a && !before[i]) {
      if (!Number.isSafeInteger(a.lamports) || a.lamports < 0) throw new Error("Account cost exceeds exact numeric range");
      rent += BigInt(a.lamports);
    }
  }
  return { feeLamports: BigInt(fee.value), rentLamports: rent, slot: simulation.context.slot, units: simulation.value.unitsConsumed ?? null };
}

async function finishAction(connection: Connection, p: Omit<PreparedDepotAction, "review" | "instructionKey" | "observedSlot">, spend = 0n): Promise<PreparedDepotAction> {
  const { PublicKey, ComputeBudgetProgram } = await import("@solana/web3.js");
  // The SDK's migration builder includes its own limit. Pin exactly one reviewed budget.
  p.tx.instructions = p.tx.instructions.filter(i => !i.programId.equals(ComputeBudgetProgram.programId));
  p.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: p.kind === "migrate" ? 700_000 : 500_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  const { assertDepotInstructions, preserveDepotWsol } = await import("./depot-proof");
  if (p.kind === "claim-curve" || p.kind === "claim-damm") await preserveDepotWsol(p.tx);
  await assertDepotInstructions(p);
  p.tx.feePayer = new PublicKey(p.binding.wallet);
  p.tx.recentBlockhash = (await bounded(connection.getLatestBlockhash("confirmed"), "Blockhash")).blockhash;
  const costs = await depotCosts(connection, p.tx, p.binding.wallet);
  const review: PreparedReview = { key: bindingKey(p.binding), createdAt: Date.now(), stages: [{ label: p.label, feeLamports: costs.feeLamports, rentLamports: costs.rentLamports + spend }] };
  const reason = reviewGuard(review, p.binding, Date.now(), p.binding);
  if (reason) throw new Error(reason);
  return { ...p, review, instructionKey: depotInstructionKey(p.tx), observedSlot: costs.slot };
}

/** Fetch exactly the published bytes. Only this application's immutable public URI is allowed. */
export async function verifyDepotMetadata(metadata: TokenMetadataDraft, origin: string, expectedHash: string) {
  const errs = validateMetadata(metadata, origin);
  if (errs.length) throw new Error(errs.join(". "));
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Publish immutable metadata first");
  const r = await fetch(metadata.metadataUri, { signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store" });
  if (!r.ok) throw new Error("Published metadata is not publicly readable");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 10_000) throw new Error("Metadata is too large");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (digest !== expectedHash) throw new Error("Published metadata digest changed");
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (body.name !== metadata.name || body.symbol !== metadata.symbol || body.description !== metadata.description || body.image !== metadata.imageUrl) throw new Error("Metadata content differs from the launch review");
}

export async function depotPresetCurve(preset: import("./depot").LaunchPreset) {
  launchMath(preset);
  const d = await loadDepotDbc();
  return d.buildCurve({
    token: { tokenType: d.TokenType.SPLToken, tokenBaseDecimal: preset.tokenDecimals, tokenQuoteDecimal: 9, tokenAuthorityOption: d.TokenAuthorityOption.Immutable, totalTokenSupply: Number(preset.totalSupplyTokens), leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: d.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: preset.tradingFeeBps, endingFeeBps: preset.tradingFeeBps, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: d.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: preset.creatorFeeShareBps / 100, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: d.MigrationOption.MET_DAMM_V2, migrationFeeOption: d.MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: d.ActivationType.Timestamp, percentageSupplyOnMigration: (10_000 - preset.curveSupplyBps) / 100, migrationQuoteThreshold: Number(preset.migrationQuoteThresholdRaw) / 1e9,
  });
}

export async function prepareDepotLaunch(connection: Connection, binding: ReviewBinding, metadata: TokenMetadataDraft, origin: string): Promise<PreparedDepotAction> {
  await assertCluster(connection, binding.cluster);
  const preset = getPreset(binding.presetId, binding.presetVersion);
  const math = launchMath(preset);
  const errs = validateRecipients(binding.wallet, binding.recipients, math);
  if (errs.length) throw new Error(errs.join(". "));
  if (binding.metadataUri !== metadata.metadataUri) throw new Error("Metadata URI differs from the review binding");
  await verifyDepotMetadata(metadata, origin, binding.metadataHash ?? "");
  const [d, { Keypair, PublicKey }] = await Promise.all([loadDepotDbc(), import("@solana/web3.js")]);
  const owner = new PublicKey(binding.wallet), config = Keypair.generate(), mint = Keypair.generate();
  const curve = await depotPresetCurve(preset);
  if (curve.tokenSupply?.preMigrationTokenSupply.toString() !== math.rawSupply.toString() || curve.migrationQuoteThreshold.toString() !== preset.migrationQuoteThresholdRaw.toString()) throw new Error("SDK economics differ from the selected preset");
  const client = new d.DynamicBondingCurveClient(connection, "confirmed");
  const tx = await bounded(client.partner.createConfigAndPool({ config: config.publicKey, feeClaimer: owner, leftoverReceiver: owner, quoteMint: new PublicKey(WSOL_MINT), payer: owner, ...curve, preCreatePoolParam: { name: metadata.name, symbol: metadata.symbol, uri: metadata.metadataUri, poolCreator: owner, baseMint: mint.publicKey } }), "DBC launch builder");
  const { BorshInstructionCoder } = await import("@coral-xyz/anchor");
  const coder = new BorshInstructionCoder(d.DynamicBondingCurveIdl as never);
  const names = tx.instructions.map(i => i.programId.toBase58() === DBC_PROGRAM ? coder.decode(i.data)?.name : null);
  if (names.length !== 2 || names[0] !== "create_config" || names[1] !== "initialize_virtual_pool_with_spl_token") throw new Error("Unexpected DBC launch instruction set");
  const target = { config: config.publicKey.toBase58(), mint: mint.publicKey.toBase58(), pool: d.deriveDbcPoolAddress(new PublicKey(WSOL_MINT), mint.publicKey, config.publicKey).toBase58() };
  return finishAction(connection, { kind: "launch", label: "Create agent token + DBC pool", target, binding: structuredClone(binding), tx, signers: [config, mint], metadataHash: binding.metadataHash, notes: ["Atomic config + SPL token pool; no initial purchase.", "Mint authority is immutable. 100% of migrated LP is permanently locked; owner position can still claim eligible fees.", "Meteora takes 20% of curve trading fees; remaining fees route to the displayed owner. DAMM v2 uses its own fee schedule after graduation."] });
}

export interface DepotLifecycle {
  target: DepotTarget; owner: string; slot: number; readAt: number;
  status: "bonding" | "ready-to-graduate" | "graduated";
  quoteReserveRaw: string; thresholdRaw: string;
  creatorBaseFeeRaw: string; creatorQuoteFeeRaw: string;
  partnerBaseFeeRaw: string; partnerQuoteFeeRaw: string;
  dammPositions: { address: string; nftAccount: string; unlockedLiquidity: string; permanentLockedLiquidity: string; feeARaw: string; feeBRaw: string }[];
}

/** Owner/program/mint/config/PDA checks precede lifecycle and fee claims. */
export async function readDepotLifecycle(connection: Connection, target: DepotTarget, owner: string, cluster: string): Promise<DepotLifecycle> {
  await assertCluster(connection, cluster);
  const [d, { PublicKey }] = await Promise.all([loadDepotDbc(), import("@solana/web3.js")]);
  const client = new d.DynamicBondingCurveClient(connection, "confirmed");
  const keys = [target.pool, target.config, target.mint].map(a => new PublicKey(a));
  const accounts = await bounded(connection.getMultipleAccountsInfoAndContext(keys, "confirmed"), "Launch identity read");
  if (accounts.value[0]?.owner.toBase58() !== DBC_PROGRAM || accounts.value[1]?.owner.toBase58() !== DBC_PROGRAM || accounts.value[2]?.owner.toBase58() !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") throw new Error("Launch accounts are absent or have unexpected program owners");
  const [pool, config, fees] = await bounded(Promise.all([client.state.getPool(keys[0]!), client.state.getPoolConfig(keys[1]!), client.state.getPoolFeeBreakdown(keys[0]!)]), "DBC lifecycle");
  if (!pool || !config) throw new Error("Pool or config unavailable");
  const s = pool.poolState;
  if (s.config.toBase58() !== target.config || s.baseMint.toBase58() !== target.mint || s.creator.toBase58() !== owner || config.feeClaimer.toBase58() !== owner || config.leftoverReceiver.toBase58() !== owner || config.quoteMint.toBase58() !== WSOL_MINT || config.migrationOption !== d.MigrationOption.MET_DAMM_V2 || d.deriveDbcPoolAddress(config.quoteMint, s.baseMint, s.config).toBase58() !== target.pool) throw new Error("Launch is not bound to this owner, mint, config and SOL/DAMM v2 route");
  if (config.tokenType !== d.TokenType.SPLToken || config.creatorPermanentLockedLiquidityPercentage !== 100 || config.creatorLiquidityPercentage !== 0 || config.partnerLiquidityPercentage !== 0 || config.partnerPermanentLockedLiquidityPercentage !== 0 || config.creatorTradingFeePercentage !== 100) throw new Error("Launch ownership, fee share or permanent LP lock differs from Depot v1");
  const { unpackMint, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  const mint = unpackMint(keys[2]!, accounts.value[2]!, TOKEN_PROGRAM_ID);
  if (mint.mintAuthority || mint.freezeAuthority || mint.decimals !== 6) throw new Error("Depot v1 requires a fixed six-decimal mint without mint/freeze authorities");
  const dammConfig = d.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error("Unsupported DAMM v2 migration fee tier");
  const dammPool = d.deriveDammV2PoolAddress(dammConfig, s.baseMint, config.quoteMint).toBase58();
  if (target.dammPool && target.dammPool !== dammPool) throw new Error("DAMM pool identity mismatch");
  const result: DepotLifecycle = { target: { ...target, dammPool }, owner, slot: accounts.context.slot, readAt: Date.now(), status: s.isMigrated ? "graduated" : s.quoteReserve.gte(config.migrationQuoteThreshold) ? "ready-to-graduate" : "bonding", quoteReserveRaw: s.quoteReserve.toString(), thresholdRaw: config.migrationQuoteThreshold.toString(), creatorBaseFeeRaw: fees.creator.unclaimedBaseFee.toString(), creatorQuoteFeeRaw: fees.creator.unclaimedQuoteFee.toString(), partnerBaseFeeRaw: fees.partner.unclaimedBaseFee.toString(), partnerQuoteFeeRaw: fees.partner.unclaimedQuoteFee.toString(), dammPositions: [] };
  if (s.isMigrated) {
    const cp = new (await loadDepotDamm()).CpAmm(connection);
    const info = await bounded(connection.getAccountInfo(new PublicKey(dammPool)), "DAMM owner");
    if (info?.owner.toBase58() !== DAMM_PROGRAM) throw new Error("Graduated pool is not owned by DAMM v2");
    const state = await bounded(cp.fetchPoolState(new PublicKey(dammPool)), "DAMM state");
    if (state.tokenAMint.toBase58() !== target.mint || state.tokenBMint.toBase58() !== WSOL_MINT) throw new Error("Graduated token pair mismatch");
    const positions = await bounded(cp.getUserPositionByPool(new PublicKey(dammPool), new PublicKey(owner)), "Owner position NFTs");
    result.dammPositions = positions.map(p => ({ address: p.position.toBase58(), nftAccount: p.positionNftAccount.toBase58(), unlockedLiquidity: p.positionState.unlockedLiquidity.toString(), permanentLockedLiquidity: p.positionState.permanentLockedLiquidity.toString(), feeARaw: p.positionState.feeAPending.toString(), feeBRaw: p.positionState.feeBPending.toString() }));
  }
  return result;
}

export async function prepareDepotMigration(connection: Connection, binding: ReviewBinding, target: DepotTarget) {
  const life = await readDepotLifecycle(connection, target, binding.wallet, binding.cluster);
  if (life.status !== "ready-to-graduate") throw new Error(life.status === "graduated" ? "Already graduated. Refresh lifecycle." : "Bonding threshold has not been reached.");
  const [d, { PublicKey }] = await Promise.all([loadDepotDbc(), import("@solana/web3.js")]);
  const client = new d.DynamicBondingCurveClient(connection, "confirmed"), config = await client.state.getPoolConfig(new PublicKey(target.config));
  if (!config) throw new Error("Launch config unavailable");
  const dammConfig = d.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error("Unsupported migration tier");
  const built = await bounded(client.migration.migrateToDammV2({ payer: new PublicKey(binding.wallet), pool: new PublicKey(target.pool), dammConfig }), "DAMM migration builder");
  return finishAction(connection, { kind: "migrate", label: "Graduate DBC → DAMM v2", target: life.target, binding: structuredClone(binding), tx: built.transaction, signers: [built.firstPositionNftKeypair, built.secondPositionNftKeypair], notes: ["Migration is its own wallet-approved transaction.", "New position NFT mint signers remain in memory. Read onchain ownership and LP locks after confirmation."] });
}

export async function prepareDepotCurveClaim(connection: Connection, binding: ReviewBinding, target: DepotTarget) {
  const life = await readDepotLifecycle(connection, target, binding.wallet, binding.cluster);
  if (BigInt(life.creatorBaseFeeRaw) + BigInt(life.creatorQuoteFeeRaw) === 0n) throw new Error("No creator curve fees currently claimable");
  const [d, { PublicKey }, { default: BN }] = await Promise.all([loadDepotDbc(), import("@solana/web3.js"), import("bn.js")]);
  const owner = new PublicKey(binding.wallet), client = new d.DynamicBondingCurveClient(connection, "confirmed");
  const tx = await bounded(client.creator.claimCreatorTradingFee({ creator: owner, payer: owner, receiver: owner, pool: new PublicKey(target.pool), maxBaseAmount: new BN(life.creatorBaseFeeRaw), maxQuoteAmount: new BN(life.creatorQuoteFeeRaw) }), "Curve fee claim");
  return finishAction(connection, { kind: "claim-curve", label: "Claim creator curve fees", target: life.target, binding: structuredClone(binding), tx, signers: [], notes: ["Claims at most the reviewed raw amounts to the owner wallet. SOL-quoted fees arrive as WSOL; existing WSOL stays open.", "A SOL reserve transfer is a separate explicit review funded from the wallet SOL balance after the claim receipt."] });
}

export async function prepareDepotDammClaim(connection: Connection, binding: ReviewBinding, target: DepotTarget, position: string) {
  const life = await readDepotLifecycle(connection, target, binding.wallet, binding.cluster);
  const owned = life.dammPositions.find(p => p.address === position);
  if (!owned || !life.target.dammPool) throw new Error("This wallet does not own that graduated position NFT");
  const [sdk, { PublicKey }] = await Promise.all([loadDepotDamm(), import("@solana/web3.js")]);
  const cp = new sdk.CpAmm(connection), pool = new PublicKey(life.target.dammPool), state = await cp.fetchPoolState(pool), owner = new PublicKey(binding.wallet);
  const tx = await bounded(cp.claimPositionFee({ owner, receiver: owner, feePayer: owner, position: new PublicKey(position), positionNftAccount: new PublicKey(owned.nftAccount), pool, tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: sdk.getTokenProgram(state.tokenAFlag), tokenBProgram: sdk.getTokenProgram(state.tokenBFlag) }), "DAMM fee claim");
  return finishAction(connection, { kind: "claim-damm", label: "Claim DAMM v2 position fees", target: life.target, binding: structuredClone(binding), tx, signers: [], notes: ["Claim-only transaction to the connected NFT owner; locked liquidity stays locked. SOL-quoted fees arrive as WSOL; existing WSOL stays open."] });
}

/** Explicit SOL routing to an owner-selected reserve; never a hosted spending permission. */
export async function prepareDepotReserve(connection: Connection, binding: ReviewBinding, target: DepotTarget, recipient: string, lamports: bigint) {
  await readDepotLifecycle(connection, target, binding.wallet, binding.cluster);
  const { PublicKey, Transaction, SystemProgram } = await import("@solana/web3.js");
  const to = new PublicKey(recipient);
  if (to.toBase58() === binding.wallet || lamports <= 0n || lamports > binding.maxStageLamports) throw new Error("Enter a distinct reserve wallet and a positive amount within the stage cap");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: new PublicKey(binding.wallet), toPubkey: to, lamports }));
  return finishAction(connection, { kind: "reserve", label: "Route SOL to operating reserve", target, binding: structuredClone(binding), tx, signers: [], notes: [`Transfer ${lamports} lamports to ${recipient}.`, "This is a wallet-approved transfer. Studio Loco does not hold this wallet's keys or promise that fees cover operating costs."] }, lamports);
}

/** Run again on tx.ts's fresh message immediately before signing; fail closed on increased costs. */
export async function checkDepotFreshCosts(connection: Connection, p: PreparedDepotAction, tx: Transaction) {
  const cost = await depotCosts(connection, tx, p.binding.wallet);
  const reviewed = p.review.stages[0]!;
  if (cost.feeLamports > reviewed.feeLamports! || cost.rentLamports > reviewed.rentLamports!) throw new Error("Network fee or account costs increased. Prepare a fresh review.");
  if (cost.feeLamports + cost.rentLamports > p.binding.maxStageLamports) throw new Error("Fresh action exceeds the stage cap");
}
