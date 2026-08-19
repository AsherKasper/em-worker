// Monad on-chain pulse, sampled from the public RPC.
//
// The task asks for a 7-day picture and says, in the publisher's own words:
// "Sin inventar números — si no hay data, decilo." So this separates three things that are easy
// to blur together, and labels every number with how it was obtained:
//
//   MEASURED    — read directly from chain state (block heights, timestamps, tx counts in a block)
//   SAMPLED     — an average over N blocks drawn across the window, with the sample size stated
//   UNAVAILABLE — cannot be derived from a public RPC without a full indexer; said so plainly
//
// Daily ACTIVE ADDRESSES is the honest UNAVAILABLE here. Distinct senders in a sample does not
// extrapolate to a daily unique-address count — the union of addresses grows sublinearly with the
// sample, so multiplying up would overstate it by an unknown factor. Reporting the sampled figure
// as if it were the daily count is exactly the invented number the publisher asked me not to hand
// them.

import { writeFileSync } from "node:fs";

const RPC = "https://rpc.monad.xyz";
const CAPTURED_AT = new Date().toISOString();

let rpcCalls = 0, rpcFails = 0;
async function rpc(method, params = [], tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      rpcCalls++;
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      throw new Error(JSON.stringify(j.error).slice(0, 80));
    } catch (e) {
      if (i === tries - 1) { rpcFails++; return null; }
      await new Promise((s) => setTimeout(s, 400 * (i + 1)));
    }
  }
}

const hex = (n) => "0x" + Math.floor(n).toString(16);
const num = (h) => (h == null ? null : parseInt(h, 16));

const head = num(await rpc("eth_blockNumber"));
if (head == null) { console.error("FATAL: no block height"); process.exit(1); }
const headBlock = await rpc("eth_getBlockByNumber", [hex(head), false]);
const headTs = num(headBlock.timestamp);

// Derive block time from a wide baseline rather than assuming it.
const BACK = 200_000;
const oldBlock = await rpc("eth_getBlockByNumber", [hex(head - BACK), false]);
const oldTs = num(oldBlock.timestamp);
const blockTimeSec = (headTs - oldTs) / BACK;
const blocksPerDay = 86_400 / blockTimeSec;
const window7d = Math.floor(blocksPerDay * 7);
const startBlock = Math.max(1, head - window7d);

console.error(`head=${head} blockTime=${blockTimeSec.toFixed(3)}s blocksPerDay=${Math.round(blocksPerDay)} window=${window7d}`);

// Sample evenly across the 7-day window, with full transaction objects.
const N = 160;
const samples = [];
const toCounts = new Map();
const senders = new Set();
for (let i = 0; i < N; i++) {
  const h = Math.floor(startBlock + ((window7d - 1) * i) / (N - 1));
  const b = await rpc("eth_getBlockByNumber", [hex(h), true]);
  if (!b || !Array.isArray(b.transactions)) continue;
  samples.push({ height: h, ts: num(b.timestamp), txCount: b.transactions.length });
  for (const t of b.transactions) {
    if (t.from) senders.add(String(t.from).toLowerCase());
    if (t.to) toCounts.set(String(t.to).toLowerCase(), (toCounts.get(String(t.to).toLowerCase()) || 0) + 1);
  }
}

const okSamples = samples.length;
const totalTx = samples.reduce((a, s) => a + s.txCount, 0);
const meanTxPerBlock = totalTx / okSamples;
// Standard error, so the estimate carries its own uncertainty instead of a bare point value.
const variance = samples.reduce((a, s) => a + (s.txCount - meanTxPerBlock) ** 2, 0) / (okSamples - 1);
const stderr = Math.sqrt(variance / okSamples);
const dailyTx = meanTxPerBlock * blocksPerDay;
const dailyTxErr = stderr * blocksPerDay;

const topTo = [...toCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([address, txInSample]) => ({ address, tx_in_sample: txInSample, share_of_sampled_tx: +(txInSample / totalTx).toFixed(4) }));

// TVL: DefiLlama is an aggregator, NOT an on-chain read. The task asked for on-chain and
// "no estimado", so it is labelled as third-party and the distinction is stated in the output.
let llamaTvl = null, llamaErr = null;
try {
  const r = await fetch("https://api.llama.fi/v2/chains", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (r.ok) { const j = await r.json(); const m = j.find((c) => /^monad$/i.test(c.name)); llamaTvl = m ? m.tvl : null; }
  else llamaErr = `HTTP ${r.status}`;
} catch (e) { llamaErr = String(e.message).slice(0, 60); }

const out = {
  chain: "Monad", chain_id: 143,
  captured_at_utc: CAPTURED_AT,
  source: { rpc: RPC, method: "JSON-RPC eth_getBlockByNumber over an evenly-spaced sample", rpc_calls: rpcCalls, rpc_failures: rpcFails },
  method_note: "Every field below is tagged MEASURED, SAMPLED or UNAVAILABLE. Nothing is estimated without saying so.",

  chain_head: { status: "MEASURED", block_height: head, block_timestamp_utc: new Date(headTs * 1000).toISOString() },
  block_time_seconds: { status: "MEASURED", value: +blockTimeSec.toFixed(4), derived_from: `timestamp delta across ${BACK} blocks` },
  blocks_per_day: { status: "MEASURED", value: Math.round(blocksPerDay) },

  daily_transaction_count_7d_avg: {
    status: "SAMPLED",
    value: Math.round(dailyTx),
    standard_error: Math.round(dailyTxErr),
    mean_tx_per_block: +meanTxPerBlock.toFixed(2),
    sample_blocks: okSamples,
    window_blocks: window7d,
    window_start_block: startBlock,
    note: `Mean transactions per block over ${okSamples} blocks evenly spaced across the trailing 7 days, multiplied by measured blocks/day. Not a full count of every block.`,
  },

  daily_active_addresses_7d_avg: {
    status: "UNAVAILABLE",
    value: null,
    distinct_senders_in_sample: senders.size,
    note: "Not derivable from a public RPC. A daily unique-address count requires indexing every block in the window; the union of distinct addresses grows sublinearly with sample size, so scaling the sampled figure up would overstate it by an unknown factor. The distinct-sender count is given ONLY as a floor observed within the sample, and must not be read as a daily active-address figure.",
  },

  top_5_by_activity: {
    status: "SAMPLED",
    ranked_by: "transaction count to address, within the sampled blocks",
    note: "These are the most-called contract addresses on-chain, ranked by tx count in the sample. Protocol names are NOT asserted — resolving an address to a dApp name needs a labels source this task's on-chain-only constraint excludes. Verify each address on the explorer.",
    entries: topTo,
  },

  aggregate_tvl_usd: {
    status: llamaTvl == null ? "UNAVAILABLE" : "THIRD_PARTY_AGGREGATOR",
    value: llamaTvl,
    source: "DefiLlama /v2/chains",
    error: llamaErr,
    note: "The task asked for TVL from an on-chain source, not estimated. This figure is NOT an on-chain read — it is DefiLlama's aggregate across the protocols it indexes on Monad. There is no single on-chain contract exposing chain-wide TVL; deriving it on-chain would mean enumerating every protocol's pools and pricing each asset. Flagged rather than presented as on-chain.",
  },

  explorer: "https://monadexplorer.com",
};

writeFileSync("monad-pulse.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
