// ERC-8128 (RFC 9421) signed HTTP client for execution.market, in Node.
//
// The vendor doc says "Do NOT reimplement the signer" and points at the OWS CLI. OWS refuses to
// run on win32-x64 and wants WSL, which this non-admin account cannot install. So this is a
// faithful PORT of the reference client published in that same doc (STEP 1c, Option A) — the
// signature base, the parameter order and the eip191 alg are copied from it rather than invented.
// If a signature is rejected, suspect this file before suspecting the server.
//
// The key is read from C:\Users\shekel\.secrets\ and never printed, logged, or written elsewhere.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Wallet } from "ethers";

const API = process.env.EM_BASE || "https://api.execution.market";

// The key is read from a file OUTSIDE the repo, or from an env var. It is never written here,
// never logged, and never sent anywhere except as a signature. Keep the file outside your working
// tree — the whole point of ERC-8128 is that the key signs requests without travelling.
const KEYFILE = process.env.EM_KEYFILE;
const RAW = process.env.EM_PRIVATE_KEY;
if (!KEYFILE && !RAW) {
  console.error("Set EM_KEYFILE=/path/to/wallet.json (a {privateKey} JSON) or EM_PRIVATE_KEY=0x...");
  process.exit(1);
}
const wallet = new Wallet(RAW || JSON.parse(readFileSync(KEYFILE, "utf8")).privateKey);
export const ADDRESS = wallet.address;

// keyid is lowercase per the doc — "the signature shape (lowercase keyid ...) is precise and fragile"
const chainKeyid = (chainId) => `erc8128:${chainId}:${wallet.address.toLowerCase()}`;

const sigParams = (covered, p) => {
  const parts = [`(${covered.map((c) => `"${c}"`).join(" ")})`];
  // Order matters and is fixed by the reference implementation. Ints unquoted, strings quoted.
  for (const k of ["created", "expires", "nonce", "keyid", "alg"]) {
    if (!(k in p)) continue;
    parts.push(typeof p[k] === "number" ? `${k}=${p[k]}` : `${k}="${p[k]}"`);
  }
  return parts.join(";");
};

async function signHeaders(method, url, body, chainId) {
  const nr = await fetch(`${API}/api/v1/auth/erc8128/nonce`, { headers: { Accept: "application/json" } });
  if (!nr.ok) throw new Error(`nonce ${nr.status}`);
  const nonce = (await nr.json()).nonce;

  const u = new URL(url);
  const created = Math.floor(Date.now() / 1000);
  const covered = ["@method", "@authority", "@path"];
  let contentDigest = null;
  // NOTE: u.search includes the leading "?"; the doc's @query line is `?<query>`, so strip and re-add.
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  if (query) covered.push("@query");
  if (body) {
    const b64 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("base64");
    contentDigest = `sha-256=:${b64}:`;
    covered.push("content-digest");
  }
  const params = { created, expires: created + 300, nonce, keyid: chainKeyid(chainId), alg: "eip191" };
  const sp = sigParams(covered, params);

  const lines = [];
  for (const c of covered) {
    if (c === "@method") lines.push(`"@method": ${method.toUpperCase()}`);
    else if (c === "@authority") lines.push(`"@authority": ${u.host}`);
    else if (c === "@path") lines.push(`"@path": ${u.pathname}`);
    else if (c === "@query") lines.push(`"@query": ?${query}`);
    else if (c === "content-digest") lines.push(`"content-digest": ${contentDigest}`);
  }
  lines.push(`"@signature-params": ${sp}`);
  const base = lines.join("\n");

  // EIP-191 personal_sign over the signature base -> 65-byte r||s||v, base64'd.
  const sigHex = await wallet.signMessage(base);
  const sigB64 = Buffer.from(sigHex.slice(2), "hex").toString("base64");

  const h = { Signature: `eth=:${sigB64}:`, "Signature-Input": `eth=${sp}` };
  if (contentDigest) h["Content-Digest"] = contentDigest;
  return h;
}

export async function signedFetch(method, path, data, { chainId = 8453, extra = {} } = {}) {
  const url = path.startsWith("http") ? path : API + path;
  const body = data === undefined ? null : JSON.stringify(data);
  const auth = await signHeaders(method, url, body, chainId);
  const headers = { Accept: "application/json", ...auth, ...extra };
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method, headers, body: body ?? undefined, signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
