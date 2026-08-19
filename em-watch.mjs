// Watch for the two events that would actually need me to act, and for the failure that would
// otherwise look exactly like "nothing is happening".
//
//   ASSIGNED  — a publisher assigned me a task; I have to deliver before its deadline
//   ORDER     — someone ordered one of my service listings (auto-assigns me, no ranking)
//   POLLER-DEAD — the auto-applier stopped; silence from it is NOT evidence that no tasks appeared
//
// Coverage note: a watcher that only prints good news is indistinguishable from a watcher that
// died. The poller-liveness check is here for exactly that reason.

import { execSync } from "node:child_process";
import { signedFetch } from "./em8128.mjs";
import { readFileSync } from "node:fs";

const MINE = process.env.EM_EXECUTOR_ID;
const announced = new Set();
const heldByMe = new Map(); // task id -> was it assigned to me on the previous pass
let pollerWasAlive = true;

const pollerAlive = () => {
  try {
    const out = execSync(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object {$_.CommandLine -like \'*em-autoapply*\'} | Measure-Object | Select-Object -ExpandProperty Count"',
      { encoding: "utf8", timeout: 60_000 }
    );
    return parseInt(String(out).trim(), 10) > 0;
  } catch { return true; } // never report death on a failed check
};

for (;;) {
  // 1. assignment on anything I applied to.
  //
  // Announce on the TRANSITION into being mine, not once-ever. Task ca7885da was assigned to me
  // and then rolled back when the escrow lock failed (assigning -> published, executor cleared).
  // The first version of this loop latched "already announced" per task, so a genuine
  // re-assignment of that same task would have arrived in total silence — the failure mode is
  // indistinguishable from never being picked.
  try {
    let ids = [];
    try { ids = JSON.parse(readFileSync("./em-applied.json", "utf8")); } catch {}
    for (const id of ids) {
      const r = await signedFetch("GET", "/api/v1/tasks/" + id);
      const t = r.json?.task ?? r.json;
      if (!t?.id) continue;
      const isMine = t.executor_id === MINE;
      const was = heldByMe.get(id) === true;
      if (isMine && !was) {
        console.log(`ASSIGNED ${id} $${t.bounty_usd} [${t.payment_network}] escrow=${t.escrow_status} deadline ${t.deadline} :: ${String(t.title).slice(0, 60)}`);
      } else if (!isMine && was) {
        console.log(`UNASSIGNED ${id} — reverted to ${t.status}/${t.escrow_status}; the escrow lock did not hold`);
      }
      heldByMe.set(id, isMine);
    }
  } catch (e) { console.log(`WATCH-ERROR applications: ${String(e.message).slice(0, 80)}`); }

  // 2. orders against my listings
  try {
    const r = await signedFetch("GET", "/api/v1/services/mine");
    for (const l of r.json?.listings ?? []) {
      const n = Number(l.order_count ?? l.orders ?? 0) || 0;
      if (n > 0 && !announced.has("o" + l.id + n)) {
        announced.add("o" + l.id + n);
        console.log(`ORDER on listing ${l.id} — ${n} order(s) :: ${String(l.title).slice(0, 60)}`);
      }
    }
  } catch (e) { console.log(`WATCH-ERROR listings: ${String(e.message).slice(0, 80)}`); }

  // 3. the auto-applier is still running
  const alive = pollerAlive();
  if (!alive && pollerWasAlive) console.log("POLLER-DEAD em-autoapply.mjs is no longer running — applications have stopped");
  pollerWasAlive = alive;

  await new Promise((s) => setTimeout(s, 120_000));
}
