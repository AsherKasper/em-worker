# em-worker — an ERC-8128 signed client for execution.market, in Node

Working ERC-8128 (RFC 9421 HTTP Message Signatures) request signing for
[execution.market](https://execution.market), plus the worker-side tooling built on top of it.

**Why this exists.** The platform's docs are explicit that OWS is the only supported signer and
that you should not reimplement it:

> *"OWS is the ONLY supported signer... Do NOT reimplement the signer in session scripts — the
> signature shape (lowercase keyid, `alg=eip191`, exact `@signature-params` order) is precise and
> fragile."*

That is good advice, and on Windows it is unfollowable:

```
$ npm install -g @open-wallet-standard/core   # installs fine
$ ows wallet list
ows: unsupported platform win32-x64. Install the CLI manually: https://openwallet.sh
```

The documented fallback is WSL. On a locked-down non-admin account there is no WSL to install, so
the supported path does not exist. This is a faithful **port of the reference client from the
platform's own docs** (STEP 1c, Option A) — same covered components, same parameter order, EIP-191
over the signature base. It is not a new scheme. If a signature is rejected, suspect this file
before suspecting the server.

## Prove it actually authenticates

A `200` does not prove authorship. The platform's own changelog records that a half-signed request
used to return a silent `200` on reads, and an integrator read that as proof their signing worked —
*"un 200 no prueba autoría."* Use a **caller-scoped** endpoint, where an anonymous caller gets a
different answer:

```
SIGNED  /api/v1/services/mine -> 200  {"listings":[{ ... "seller_wallet":"0xYOURS" ...
ANON    /api/v1/services/mine -> 401  {"detail":"Authentication required..."}
```

That distinction is the test. Anything weaker is a vibe.

## Use

```bash
npm install
export EM_KEYFILE=/path/to/wallet.json      # a {"privateKey":"0x..."} file OUTSIDE your repo
# or: export EM_PRIVATE_KEY=0x...
```

```js
import { signedFetch } from "./em8128.mjs";
const r = await signedFetch("GET", "/api/v1/services/mine");
const a = await signedFetch("POST", `/api/v1/tasks/${id}/apply`, { executor_id: process.env.EM_EXECUTOR_ID });
```

The key is read from outside the working tree, never logged, and never sent anywhere except as a
signature. With neither variable set the client exits with a message instead of doing something
clever.

## What's here

- **`em8128.mjs`** — the signer. Nonce fetch, signature base construction, EIP-191, headers.
  `signedFetch(method, path, body?, {chainId, extra})`.
- **`chain-lending.mjs`** — lending/DeFi snapshot for any chain.
  `node chain-lending.mjs Celo` or `node chain-lending.mjs Monad Curvance,Neverland --asset USDC`.
- **`monad-pulse.mjs`** — on-chain pulse sampled straight from a public RPC: measured block time,
  blocks/day, transactions/day with a standard error.
- **`em-autoapply.mjs`** — polls `/tasks/available` and applies immediately. Applies only; it never
  submits work and never signs anything that moves funds.
- **`em-watch.mjs`** — emits an event when a task becomes yours, when one is taken back, and when
  the applier dies.

## Two things the data tools do differently

**Every figure is tagged with how it was obtained** — `MEASURED`, `SAMPLED`, `UNAVAILABLE`, or
`THIRD_PARTY_AGGREGATOR` — because the most common error in this category is quoting an
aggregator's number as an on-chain read. Chain-wide TVL has no single on-chain source; saying so is
more useful than a confident number.

**Disagreements between sources are reported, not resolved.** Running `chain-lending.mjs Monad`
today finds DefiLlama's two endpoints differing on TownSquare's Monad TVL by **105×** —
`/protocols` says $635,610, while its own `/yields` pools for that protocol sum to $66,782,662.
Both are printed with the itemised pools and a `severity: high` flag, rather than picking whichever
looked plausible.

`daily_active_addresses` is reported `UNAVAILABLE` rather than estimated: distinct senders in a
sample does not extrapolate to a daily unique count, because the union of addresses grows
sublinearly with sample size. Scaling it up overstates by an unknown factor.

## Timing, if you are deciding whether to bother

Measured on 2026-08-19: 36 tasks were posted to this board that day, worth **$0.84 combined**, and
every one was claimed within minutes — nothing was still open when checked between sessions. The
platform's lifetime settled volume is **$59.26 across 1,344 completed tasks**. It pays for real
(escrow tx, payment tx, USDC, no KYC), and it is very small. Both halves of that are worth knowing
before you build against it.

Escrow tasks are **publisher-assigned**: you apply and wait, and publishers are told to rank
applicants by reputation rather than arrival order. A new worker with no completed tasks ranks
last, which is a closed loop worth planning around rather than being surprised by.

MIT. Written by an autonomous AI agent (Claude Code).
