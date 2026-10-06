import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Cap, PageHead, Panel } from "@/components/kit";

export const Route = createFileRoute("/lab/architecture")({
  head: () => ({
    meta: [
      { title: "Confidential coordination on Solana: what it takes — Studio Loco" },
      { name: "description", content: "The components a real confidential-coordination deployment on Solana would need: MPC/FHE network, verifier, authenticated inputs, committee, data availability, settlement and audits." },
      { property: "og:title", content: "What real private coordination on Solana needs" },
      { property: "og:description", content: "An honest architecture checklist. None of it is deployed by Studio Loco." },
    ],
  }),
  component: Arch,
});

const PARTS = [
  { t: "Confidential compute network", d: "An MPC or threshold-FHE execution network (on Solana, Arcium's MXE/Arcis model is one candidate) run by independent operators, so no single party can decrypt inputs." },
  { t: "Committee selection & key generation", d: "Verifiable random selection of a committee per computation and distributed key generation, with the public key published onchain before inputs open." },
  { t: "Authenticated input binding", d: "Inputs signed by eligible wallets and bound to a computation id, with replay protection, eligibility proofs (allowlists, token snapshots) and a deadline enforced by slot or timestamp." },
  { t: "Verifier / callback program", d: "An Anchor program that accepts results only via validated callbacks with proofs or committee signatures, and rejects anything else." },
  { t: "Data availability", d: "Ciphertexts and transcripts stored where anyone can fetch and re-verify them for the dispute window." },
  { t: "Economic security", d: "Operator bonding, slashing for provable misbehaviour, fees, timeouts and refunds for computations that fail to complete." },
  { t: "Settlement & disclosure controls", d: "Onchain settlement of only the aggregate, with explicit rules on what is revealed (e.g. winner + clearing price) and nothing more." },
  { t: "Audits & staged rollout", d: "Independent audits of circuits, programs and operator software; testnet phase; bug bounty; limits before mainnet value." },
];

function Arch() {
  return (
    <SiteLayout>
      <PageHead code="LAB · Architecture" title="What real private coordination needs." intro="Studio Loco's Lab is a local simulation. A deployed system on Solana would need every component below. None of these are deployed by Studio Loco." cap={["not-deployed"]} />
      <ol className="grid gap-4 md:grid-cols-2">
        {PARTS.map((p, i) => (
          <li key={p.t}><Panel><p className="station-code text-amber">Component {String(i + 1).padStart(2, "0")}</p><h2 className="mt-2 text-xl font-semibold">{p.t}</h2><p className="mt-2 text-sm text-cream/80">{p.d}</p><Cap kind="not-deployed" className="mt-3" /></Panel></li>
        ))}
      </ol>
      <Panel className="mt-8" tone="cobalt">
        <h2 className="display text-2xl">And Meteora?</h2>
        <p className="mt-2 text-cream/85">Even with such a network, DLMM execution stays public. A private auction could decide a clearing price confidentially and then settle publicly into a pool — the privacy applies to the decision, not the swap.</p>
        <p className="mt-3"><Link to="/lab" className="underline">Back to the Lab</Link> · <Link to="/journal/$slug" params={{ slug: "what-encryption-is-not" }} className="underline">Field Note FN-003</Link></p>
      </Panel>
    </SiteLayout>
  );
}
