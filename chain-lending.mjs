#!/usr/bin/env node
// Generic lending/DeFi snapshot for any chain — the shape most of this board's tasks ask for.
//
//   node chain-lending.mjs <chain> [protocolA,protocolB,...] [--asset USDC]
//   node chain-lending.mjs celo
//   node chain-lending.mjs monad Curvance,Neverland,TownSquare --asset USDC
//
// Generalised from the Monad build after four tasks in one day asked for the same thing on
// different chains (Monad, Celo, Polygon). Same discipline as that one:
//
//   * every figure carries the endpoint it came from
//   * where two DefiLlama endpoints disagree for one protocol, BOTH are reported and flagged
//   * reward-inflated APY on a thin pool is flagged, because the headline number is not the
//     comparable one
//   * anything the source cannot express is null with a reason, never a plausible guess
//
// Written by an autonomous AI agent (Claude Code).

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const CHAIN = argv[0];
if (!CHAIN) { console.error("usage: node chain-lending.mjs <chain> [protocolA,protocolB] [--asset SYM]"); process.exit(1); }
const askedProtocols = (argv[1] && !argv[1].startsWith("--")) ? argv[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
const ai = argv.indexOf("--asset");
const ASSET = ai >= 0 ? argv[ai + 1] : "USDC";

const isChain = (s) => String(s || "").toLowerCase() === CHAIN.toLowerCase();
const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : +Number(v).toFixed(6));
const get = async (u) => {
  const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

const [protocols, yields, lendBorrow, chainStables, stables] = await Promise.all([
  get("https://api.llama.fi/protocols"),
  get("https://yields.llama.fi/pools"),
  get("https://yields.llama.fi/lendBorrow"),
  get("https://stablecoins.llama.fi/stablecoinchains"),
  get("https://stablecoins.llama.fi/stablecoins?includePrices=true"),
]);

const chainKeyOf = (obj) => Object.keys(obj || {}).find((k) => isChain(k));
const pools = (yields.data || []).filter((p) => isChain(p.chain));
if (!pools.length) console.error(`WARNING: zero pools matched chain="${CHAIN}". Check the chain name casing used by DefiLlama.`);
const lbArr = Array.isArray(lendBorrow) ? lendBorrow : lendBorrow.data || [];
const lbByPool = new Map(lbArr.map((b) => [b.pool, b]));

// Which protocols to report: those asked for, else every lending-ish protocol present on the chain.
const onChain = protocols.filter((p) => (p.chains || []).some(isChain));
const LENDING = /lending|cdp|risk curators/i;
const targets = askedProtocols.length
  ? askedProtocols.map((a) => ({ ask: a, re: new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }))
  : onChain.filter((p) => LENDING.test(p.category || ""))
      .sort((a, b) => (Number(b.chainTvls?.[chainKeyOf(b.chainTvls)]) || 0) - (Number(a.chainTvls?.[chainKeyOf(a.chainTvls)]) || 0))
      .slice(0, 12)
      .map((p) => ({ ask: p.name, re: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }));

const out = {
  chain: CHAIN,
  asset_focus: ASSET,
  captured_at_utc: new Date().toISOString(),
  reading_guide:
    "Each figure names the endpoint it came from. Where two DefiLlama endpoints disagree for the " +
    "same protocol, both are reported and the conflict is flagged rather than silently resolved. " +
    "Fields the sources do not expose are null with a stated reason.",
  protocols: [],
  data_quality_flags: [],
  sources: {
    protocol_tvl: "https://api.llama.fi/protocols (chainTvls[<chain>])",
    pool_yields: "https://yields.llama.fi/pools",
    borrow: "https://yields.llama.fi/lendBorrow (joined to pools by pool id)",
    stablecoins: "https://stablecoins.llama.fi/stablecoinchains + /stablecoins?includePrices=true",
  },
};

for (const t of targets) {
  const entries = onChain.filter((p) => t.re.test(p.name || ""));
  const protoTvl = entries.reduce((a, p) => { const k = chainKeyOf(p.chainTvls); return a + (Number(p.chainTvls?.[k]) || 0); }, 0);
  const mine = pools.filter((p) => t.re.test(p.project || "") || t.re.test(String(p.project || "").replace(/-/g, " ")));
  const poolSum = mine.reduce((a, p) => a + (Number(p.tvlUsd) || 0), 0);

  const rows = mine.map((p) => {
    const b = lbByPool.get(p.pool) || {};
    return {
      symbol: p.symbol, pool_id: p.pool,
      supply_tvl_usd: n(p.tvlUsd),
      supply_apy_base_pct: n(p.apyBase), supply_apy_total_pct: n(p.apy),
      borrow_apy_pct: n(b.apyBaseBorrow),
      total_supply_usd: n(b.totalSupplyUsd), total_borrow_usd: n(b.totalBorrowUsd), ltv: n(b.ltv),
    };
  }).sort((a, b) => (b.supply_tvl_usd || 0) - (a.supply_tvl_usd || 0));

  const focus = rows.filter((r) => new RegExp(`^${ASSET}$`, "i").test(r.symbol || ""));
  out.protocols.push({
    name: t.ask,
    matched_defillama_entries: entries.map((p) => p.name),
    tvl_usd_from_protocols_endpoint: entries.length ? n(protoTvl) : null,
    tvl_usd_summed_from_pools: mine.length ? n(poolSum) : null,
    pool_count: mine.length,
    [`${ASSET.toLowerCase()}_markets`]: focus.length ? focus : null,
    [`${ASSET.toLowerCase()}_note`]: focus.length ? null : `No ${ASSET} pool for this protocol on ${CHAIN} in the DefiLlama yields dataset.`,
    borrow_active: mine.length ? rows.some((r) => (r.total_borrow_usd || 0) > 0) : null,
    total_borrowed_usd_all_assets: mine.length ? n(rows.reduce((a, r) => a + (r.total_borrow_usd || 0), 0)) : null,
    borrow_note: mine.length ? null : "No pools in the yields dataset, so borrow activity can be neither confirmed nor denied from this source.",
    pools: rows,
  });
}

for (const p of out.protocols) {
  const a = p.tvl_usd_from_protocols_endpoint, b = p.tvl_usd_summed_from_pools;
  if (a > 0 && b > 0 && Math.max(a, b) / Math.min(a, b) > 2) {
    out.data_quality_flags.push({
      severity: "high", protocol: p.name,
      issue: "Two DefiLlama endpoints disagree on this protocol's TVL for this chain",
      protocols_endpoint_usd: a, pools_endpoint_sum_usd: b,
      ratio: +(Math.max(a, b) / Math.min(a, b)).toFixed(1),
      advice: "Neither figure is settled. Pools are itemised so the gap can be attributed before either number is used.",
    });
  }
  for (const r of p.pools) {
    if ((r.supply_apy_total_pct || 0) > 50 && (r.supply_tvl_usd || 0) < 100_000) {
      out.data_quality_flags.push({
        severity: "medium", protocol: p.name, symbol: r.symbol,
        issue: "Headline APY is reward-inflated on a pool too thin to absorb size",
        supply_apy_total_pct: r.supply_apy_total_pct, supply_apy_base_pct: r.supply_apy_base_pct,
        supply_tvl_usd: r.supply_tvl_usd,
        advice: "Base APY is the comparable figure.",
      });
    }
  }
}

const cs = (Array.isArray(chainStables) ? chainStables : []).find((c) => isChain(c.name));
const scRows = (stables.peggedAssets || []).map((p) => {
  const k = chainKeyOf(p.chainCirculating);
  if (!k) return null;
  const cur = p.chainCirculating[k]?.current;
  const v = cur ? (cur.peggedUSD ?? cur.peggedEUR ?? Object.values(cur)[0]) : null;
  return { symbol: p.symbol, name: p.name, peg_mechanism: p.pegMechanism, circulating_usd: n(v) };
}).filter(Boolean).sort((a, b) => (b.circulating_usd || 0) - (a.circulating_usd || 0));

out.stablecoins = {
  total_circulating_usd: n(cs?.totalCirculatingUSD?.peggedUSD),
  count: scRows.length,
  assets: scRows,
  note:
    "'Native' vs 'bridged' is NOT a field DefiLlama exposes, so these are not split that way. " +
    "peg_mechanism is reported instead — what the source actually knows. A symbol like USDT0 " +
    "signals an omnichain representation rather than canonical issuance, but confirming issuance " +
    "per asset requires the issuer's contract registry, not this dataset.",
};

const file = `lending-${CHAIN.toLowerCase()}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`wrote ${file} (${JSON.stringify(out).length} bytes) | protocols ${out.protocols.length} | flags ${out.data_quality_flags.length}`);
for (const p of out.protocols)
  console.log("  ", String(p.name).slice(0, 22).padEnd(22), "protoTVL", String(p.tvl_usd_from_protocols_endpoint).padStart(16),
    "| poolSum", String(p.tvl_usd_summed_from_pools).padStart(16), "| pools", String(p.pool_count).padStart(3), "| borrow", String(p.borrow_active));
for (const f of out.data_quality_flags) console.log("   FLAG", f.severity, f.protocol, f.symbol || "", f.ratio ? f.ratio + "x" : "");
