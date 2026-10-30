// The per-call alert cap (security review M2). Runs under plain Node:
//   node --test tests/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_FAILED, ALERT_SENT } from "../src/alert.ts";
import { AlertCap, CALLER_CALLS_PER_HOUR, heldReply, MAX_OTHER_PER_CALL, MAX_PER_CALL, MAX_TRIES, REPEAT_CALLER_CAP } from "../src/cap.ts";

const ALERT = "alert_on_call_plumber";
const URGENT = { priority: "urgent" as const, kind: "water", callerId: "+14155550172" };

// Sends `body` through the cap the way index.ts does; returns the decision.
function send(cap: AlertCap, callId: string | null, body: string, delivered = 1, opts = URGENT, tool = ALERT) {
  const d = cap.check(callId, tool, body, opts);
  if (d.send) cap.record(callId, tool, body, delivered, opts);
  return d;
}

test("the first alert of a call always goes out, at urgent", () => {
  const cap = new AlertCap();
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe"), { send: true, priority: "urgent" });
});

test("later updates go at high, not urgent", () => {
  const cap = new AlertCap();
  send(cap, "call_1", "WATER: burst pipe");
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe\nCall back: 4155550199"), { send: true, priority: "high" });
});

test("a body identical to one already delivered isn't sent again", () => {
  const cap = new AlertCap();
  send(cap, "call_1", "WATER: burst pipe");
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe"), { send: false, why: "duplicate" });
});

test(`a call delivers at most ${MAX_PER_CALL} alerts; another call is unaffected`, () => {
  const cap = new AlertCap();
  for (let i = 0; i < MAX_PER_CALL; i++) assert.equal(send(cap, "call_1", `update ${i}`).send, true);
  assert.deepEqual(send(cap, "call_1", "update 99"), { send: false, why: "capped" });
  assert.deepEqual(send(cap, "call_2", "WATER: burst pipe", 1, { ...URGENT, callerId: "+15105550123" }), { send: true, priority: "urgent" });
});

test("a new emergency kind gets through at urgent, even past the cap", () => {
  const cap = new AlertCap();
  for (let i = 0; i < MAX_PER_CALL; i++) send(cap, "call_1", `update ${i}`);
  assert.deepEqual(send(cap, "call_1", "GAS: smells gas", 1, { ...URGENT, kind: "gas" }), { send: true, priority: "urgent" });
  assert.deepEqual(send(cap, "call_1", "GAS: smells gas, outside now", 1, { ...URGENT, kind: "gas" }), { send: false, why: "capped" });
});

test("until something is delivered, every try goes, at urgent (a failed first alert can still get through)", () => {
  const cap = new AlertCap();
  for (let i = 0; i < MAX_TRIES; i++) {
    // Same body each time: a retry of a failed alert is not a duplicate.
    assert.deepEqual(send(cap, "call_1", "WATER: burst pipe", 0), { send: true, priority: "urgent" });
  }
  // After MAX_TRIES failures the channel is treated as down; nothing was ever delivered, so the reply says so.
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe"), { send: false, why: "dead_channel" });
});

test("a failed send isn't counted as delivered, so it doesn't make the next one a duplicate", () => {
  const cap = new AlertCap();
  send(cap, "call_1", "WATER: burst pipe", 0);
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe", 1), { send: true, priority: "urgent" });
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe"), { send: false, why: "duplicate" });
});

test("person requests and messages have their own, smaller cap, separate from alerts", () => {
  const cap = new AlertCap();
  const high = { priority: "high" as const, callerId: "+14155550172" };
  for (let i = 0; i < MAX_OTHER_PER_CALL; i++) {
    assert.deepEqual(send(cap, "call_1", `wants a person ${i}`, 1, high, "request_person_callback"), { send: true, priority: "high" });
  }
  assert.deepEqual(send(cap, "call_1", "wants a person again", 1, high, "request_person_callback"), { send: false, why: "capped" });
  assert.deepEqual(send(cap, "call_1", "WATER: burst pipe"), { send: true, priority: "urgent" }); // the alert is untouched
});

test("a caller ID that alerted on several other calls this hour gets a smaller cap, but every call's first alert goes", () => {
  let now = 0;
  const cap = new AlertCap(() => now);
  const same = { ...URGENT, callerId: "(415) 555-0172" }; // same number, written differently
  for (let c = 0; c < CALLER_CALLS_PER_HOUR; c++) send(cap, `prank_${c}`, "WATER: burst pipe", 1, same);
  assert.deepEqual(send(cap, "prank_next", "WATER: burst pipe", 1, same), { send: true, priority: "urgent" });
  for (let i = 1; i < REPEAT_CALLER_CAP; i++) assert.equal(send(cap, "prank_next", `update ${i}`, 1, same).send, true);
  assert.deepEqual(send(cap, "prank_next", "update 99", 1, same), { send: false, why: "capped" });

  // An hour later the earlier calls no longer count.
  now += 61 * 60 * 1000;
  send(cap, "later", "WATER: burst pipe", 1, same);
  for (let i = 1; i < MAX_PER_CALL; i++) assert.equal(send(cap, "later", `update ${i}`, 1, same).send, true);
});

test("no call id: nothing to count against, so it goes", () => {
  const cap = new AlertCap();
  for (let i = 0; i < MAX_PER_CALL + 2; i++) assert.equal(send(cap, null, "WATER: burst pipe").send, true);
});

test("memory stays bounded: old calls are forgotten", () => {
  let now = 0;
  const cap = new AlertCap(() => now);
  for (let i = 0; i < MAX_PER_CALL; i++) send(cap, "call_1", `update ${i}`);
  now += 61 * 60 * 1000;
  // Forgotten, so it starts over (a call lasts 10 minutes at most, so this never frees a live one).
  assert.deepEqual(send(cap, "call_1", "update 99"), { send: true, priority: "urgent" });
});

test("a held push is never reported as sent, and never as 'nobody was told' when the plumber has the call", () => {
  for (const why of ["duplicate", "capped"] as const) {
    const r = heldReply("t1", why, ALERT_FAILED) as { toolCallId: unknown; result?: string; error?: string };
    assert.equal(r.toolCallId, "t1");
    assert.equal(r.error, undefined);
    assert.ok(r.result && !r.result.includes(ALERT_SENT));
    assert.match(r.result!, /^Not sent/);
    assert.match(r.result!, /don't use the tool again/);
  }
  // Nothing was ever delivered on this call: that's the honest ALERT_FAILED.
  assert.deepEqual(heldReply("t1", "dead_channel", ALERT_FAILED), { toolCallId: "t1", error: ALERT_FAILED });
});
