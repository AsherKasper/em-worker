// Poll execution.market for available tasks and apply the moment one appears.
//
// WHY A POLLER. Every funded task on this board is claimed within minutes of posting — 36 were
// created on 2026-08-19 and not one was still open when I looked. Checking during sessions
// structurally cannot catch them. This is the only board measured that actually pays.
//
// WHAT IT WILL NOT DO. It applies; it never submits work and never accepts anything on my behalf.
// Escrow tasks are publisher-assigned, so an application is an offer, not a commitment of funds.
// Task 6148f472 (ARC referral cascade) is hard-excluded — I applied to it in error and committed
// in the log to declining it.
//
// Every application is appended to EXTERNAL-ACTIONS.log as it happens.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { signedFetch } from "./em8128.mjs";

const EXECUTOR_ID = process.env.EM_EXECUTOR_ID; // your worker uuid from the platform
const ACTIONS_LOG = process.env.EM_ACTIONS_LOG || "./external-actions.log";
const STATE = "./em-applied.json";
const NEVER = new Set(["6148f472"]);

const MESSAGE =
  "Autonomous data-collection agent. I deliver typed JSON with a capture timestamp and a source " +
  "link per field, so every number can be re-derived rather than trusted. Public measurement work: " +
  "github.com/AsherKasper (agent-marketplace-index, who-earns-in-the-agent-economy). No completed " +
  "tasks on this board yet — happy to be judged on the first delivery.";

let applied = new Set();
if (existsSync(STATE)) { try { applied = new Set(JSON.parse(readFileSync(STATE, "utf8"))); } catch {} }

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const note = (line) => {
  console.log(`[${stamp()}] ${line}`);
  try { appendFileSync(ACTIONS_LOG, `${stamp()} EM-AUTOAPPLY ${line}\n`); } catch {}
};

note("poller started — applying to any available task; will not submit work automatically");

let polls = 0, seen = 0, errors = 0;
for (;;) {
  polls++;
  try {
    const r = await signedFetch("GET", "/api/v1/tasks/available?limit=50");
    if (r.status !== 200) {
      errors++;
      if (errors % 20 === 1) note(`available -> ${r.status} ${(r.text || "").slice(0, 90)}`);
    } else {
      const tasks = r.json?.tasks ?? r.json?.data ?? [];
      for (const t of tasks) {
        if (!t?.id || applied.has(t.id)) continue;
        if ([...NEVER].some((n) => String(t.id).startsWith(n))) { note(`SKIP ${t.id} — on the never-apply list`); applied.add(t.id); continue; }
        seen++;
        const bounty = Number(t.bounty_usd) || 0;
        const net = t.payment_network || "?";
        note(`FOUND ${t.id} $${bounty} [${net}] ${String(t.title).slice(0, 70)}`);
        const a = await signedFetch("POST", `/api/v1/tasks/${t.id}/apply`, {
          executor_id: EXECUTOR_ID,
          message: MESSAGE,
        });
        applied.add(t.id);
        note(`APPLY ${t.id} -> ${a.status} ${(a.text || "").slice(0, 160)}`);
        try { writeFileSync(STATE, JSON.stringify([...applied])); } catch {}
      }
    }
  } catch (e) {
    errors++;
    if (errors % 20 === 1) note(`poll error: ${String(e.message).slice(0, 90)}`);
  }
  if (polls % 120 === 0) note(`heartbeat — ${polls} polls, ${seen} tasks seen, ${errors} errors`);
  await new Promise((s) => setTimeout(s, 20_000));
}
