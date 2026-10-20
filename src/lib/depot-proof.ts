/** Installed-IDL instruction/recipient checks, separate from the SDK builders. */
import type { Transaction } from "@solana/web3.js";
import { DAMM_PROGRAM, DBC_PROGRAM, loadDepotDbc, loadDepotDamm, type PreparedDepotAction } from "./depot-chain";
import { WSOL_MINT } from "./depot";

type Account = { name: string; signer?: boolean; writable?: boolean; address?: string };
export async function assertDepotInstructions(p: Omit<PreparedDepotAction, "review" | "instructionKey" | "observedSlot">) {
  const [{ BorshInstructionCoder }, web3, spl, dbc] = await Promise.all([import("@coral-xyz/anchor"), import("@solana/web3.js"), import("@solana/spl-token"), loadDepotDbc()]);
  const owner = p.binding.wallet;
  const ownerKey = new web3.PublicKey(owner);
  const ata = (m: string) => spl.getAssociatedTokenAddressSync(new web3.PublicKey(m), ownerKey).toBase58();
  const dbcIdl = dbc.DynamicBondingCurveIdl;
  const cpIdl = p.kind === "claim-damm" ? (await loadDepotDamm()).CpAmmIdl : undefined;
  const allowedNames: Record<string, string[]> = { launch: ["create_config", "initialize_virtual_pool_with_spl_token"], migrate: ["migration_damm_v2"], "claim-curve": ["claim_creator_trading_fee"], "claim-damm": ["claim_position_fee"], reserve: [] };
  const actualNames: string[] = [];
  let transfers = 0;
  for (const ix of p.tx.instructions) {
    const program = ix.programId.toBase58();
    if (ix.programId.equals(web3.ComputeBudgetProgram.programId)) continue;
    if (ix.programId.equals(web3.SystemProgram.programId) && p.kind === "reserve") {
      const transfer = web3.SystemInstruction.decodeTransfer(ix);
      if (transfer.fromPubkey.toBase58() !== owner || transfer.toPubkey.toBase58() === owner || transfer.lamports <= 0n || transfer.lamports > p.binding.maxStageLamports) throw new Error("Unexpected operating reserve transfer");
      transfers++; continue;
    }
    if (ix.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID) && (p.kind === "claim-curve" || p.kind === "claim-damm")) {
      const m = ix.keys[3]?.pubkey.toBase58();
      if (!m || ![p.target.mint, WSOL_MINT].includes(m) || ix.data.length !== 1 || ix.data[0] !== 1 || ix.keys.length !== 6 || ix.keys[0]?.pubkey.toBase58() !== owner || ix.keys[1]?.pubkey.toBase58() !== ata(m) || ix.keys[2]?.pubkey.toBase58() !== owner || !ix.keys[4]?.pubkey.equals(web3.SystemProgram.programId) || !ix.keys[5]?.pubkey.equals(spl.TOKEN_PROGRAM_ID)) throw new Error("Unexpected token account creation recipient");
      continue;
    }
    const idl = program === DBC_PROGRAM ? dbcIdl : program === DAMM_PROGRAM ? cpIdl : undefined;
    if (!idl) throw new Error(`Depot action contains an unapproved program: ${program}`);
    const decoded = new BorshInstructionCoder(idl as never).decode(ix.data);
    if (!decoded || !allowedNames[p.kind]?.includes(decoded.name)) throw new Error("Depot action contains an unapproved instruction");
    actualNames.push(decoded.name);
    const definition = idl.instructions.find(i => i.name === decoded.name);
    if (!definition) throw new Error("Instruction missing from the installed IDL");
    const accounts = definition.accounts as unknown as Account[];
    const extra = decoded.name === "migration_damm_v2" ? 1 : 0;
    if (ix.keys.length !== accounts.length + extra) throw new Error("Unexpected instruction remaining accounts");
    const expected: Record<string, string> = {
      config: p.target.config, base_mint: p.target.mint, quote_mint: WSOL_MINT,
      token_a_mint: p.target.mint, token_b_mint: WSOL_MINT,
      fee_claimer: owner, leftover_receiver: owner, creator: owner, payer: owner, signer: owner,
      pool_creator: owner, token_a_account: ata(p.target.mint), token_b_account: ata(WSOL_MINT),
      virtual_pool: p.target.pool,
      pool: decoded.name === "migration_damm_v2" || p.kind === "claim-damm" ? p.target.dammPool! : p.target.pool,
      token_base_program: spl.TOKEN_PROGRAM_ID.toBase58(), token_quote_program: spl.TOKEN_PROGRAM_ID.toBase58(),
      token_a_program: spl.TOKEN_PROGRAM_ID.toBase58(), token_b_program: spl.TOKEN_PROGRAM_ID.toBase58(),
      amm_program: DAMM_PROGRAM, program,
    };
    // create_config has no pool account; initialize's mint signer is separately checked below.
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]!, key = ix.keys[i]!;
      if (a.address && key.pubkey.toBase58() !== a.address) throw new Error(`Wrong fixed IDL account ${a.name}`);
      const want = expected[a.name];
      if (want && key.pubkey.toBase58() !== want) throw new Error(`Unexpected ${a.name} recipient or identity`);
      if (key.isSigner && key.pubkey.toBase58() !== owner && !p.signers.some(s => s.publicKey.equals(key.pubkey))) throw new Error(`Unreviewed signer ${a.name}`);
      if (Boolean(a.signer) !== key.isSigner || Boolean(a.writable) !== key.isWritable) throw new Error(`Unexpected IDL privileges on ${a.name}`);
    }
    if (extra) {
      const remaining = ix.keys[accounts.length]!;
      if (remaining.isSigner || remaining.isWritable || !dbc.DAMM_V2_MIGRATION_FEE_ADDRESS.some(k => k.equals(remaining.pubkey))) throw new Error("Unapproved migration config");
    }
  }
  if (p.kind === "reserve") { if (transfers !== 1 || actualNames.length) throw new Error("Reserve action must contain exactly one transfer"); }
  else if (JSON.stringify(actualNames) !== JSON.stringify(allowedNames[p.kind])) throw new Error("Missing or duplicate Depot protocol instruction");
}

/** SDK claim helpers close WSOL ATAs by default. Keep all owner WSOL accounts open. */
export async function preserveDepotWsol(tx: Transaction) {
  const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  tx.instructions = tx.instructions.filter(ix => !(ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9));
}
