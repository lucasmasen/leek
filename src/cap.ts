// Copyright (c) 2026 Lucas Masen. All rights reserved. Not open source: see LICENSE.
// A cap on how many pushes one call can send (security review M2, 10/25).
//
// Before this, only the prompt limited alerts: a prank caller who kept "correcting" their number sent an urgent
// push every turn, for up to 10 minutes, on every call, into the channel pilot #1's real emergencies share (H1).
//
// The rules, per call and per tool:
//   - The first push of a call always goes, at the tool's own priority. Nothing here ever holds it back.
//   - So does the first alert of each emergency kind: a call that started as "water" and turns into "gas" gets
//     its gas alert out at urgent, cap or no cap.
//   - Until something has actually been delivered, every try goes (up to MAX_TRIES, so a dead channel isn't
//     hammered), so an emergency whose first alert failed still gets through when the channel comes back.
//   - After that: a body identical to one already delivered isn't sent again, later updates go at "high"
//     instead of "urgent", and once a call has delivered MAX_PER_CALL pushes of a tool, the rest are held.
//   - A caller ID that has already alerted on CALLER_CALLS_PER_HOUR other calls in the last hour gets a cap of
//     REPEAT_CALLER_CAP on its new calls (the first push of each still goes).
//
// Best effort, by design: the counts live in memory, per Edge Function instance. A cold start or a second
// instance starts from zero, so the real ceiling is "MAX_PER_CALL per instance". Holding state in Postgres would
// make it exact but adds a read before every alert. This is enough to stop one caller flooding a channel.
//
// A held push is never reported as sent: the reply says this one wasn't sent and the plumber already has the
// call (which is true: something was delivered first, or nothing is held). See heldReply().
//
// No Deno.* calls here, so tests/node/cap.test.ts can run it under plain Node.

import type { Priority } from "./alert.ts";

export const MAX_PER_CALL = 6; // emergency alerts; take_message and person requests get MAX_OTHER_PER_CALL
export const MAX_OTHER_PER_CALL = 3;
export const MAX_TRIES = 10; // sends that all failed: stop retrying a dead channel
export const CALLER_CALLS_PER_HOUR = 3;
export const REPEAT_CALLER_CAP = 2;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED = 5000; // calls kept in memory; the oldest go first

export type Held = "duplicate" | "capped" | "dead_channel";
export type Decision = { send: true; priority: Priority } | { send: false; why: Held };

// `at` is the last send, for prune().
type CallState = { at: number; tries: number; delivered: number; bodies: Set<string>; kinds: Set<string> };

const digitsOf = (s: string | null) => (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

export class AlertCap {
  private calls = new Map<string, CallState>();
  private callers = new Map<string, Map<string, number>>(); // caller ID digits -> call id -> when it first alerted

  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Whether to send this push, and at what priority. Call record() with the result after sending. */
  check(callId: string | null, tool: string, body: string, opts: { priority: Priority; kind?: string; callerId?: string | null }): Decision {
    // No call id (Vapi always sends one): nothing to count against, so it goes.
    if (!callId) return { send: true, priority: opts.priority };
    this.prune();
    const s = this.calls.get(`${callId}:${tool}`);
    if (!s || s.delivered === 0) {
      if (s && s.tries >= MAX_TRIES) return { send: false, why: "dead_channel" };
      return { send: true, priority: opts.priority };
    }
    if (opts.kind && !s.kinds.has(opts.kind)) return { send: true, priority: opts.priority };
    if (s.bodies.has(body)) return { send: false, why: "duplicate" };
    if (s.delivered >= this.capFor(callId, tool, opts.callerId ?? null)) return { send: false, why: "capped" };
    return { send: true, priority: opts.priority === "urgent" ? "high" : opts.priority };
  }

  /** Counts a send that happened. `delivered` is how many of the shop's channels took it (a real 2xx). */
  record(callId: string | null, tool: string, body: string, delivered: number, opts: { kind?: string; callerId?: string | null } = {}) {
    if (!callId) return;
    const key = `${callId}:${tool}`;
    const s = this.calls.get(key) ?? { at: this.now(), tries: 0, delivered: 0, bodies: new Set(), kinds: new Set() };
    s.at = this.now();
    s.tries++;
    if (delivered > 0) {
      s.delivered++;
      s.bodies.add(body);
      if (opts.kind) s.kinds.add(opts.kind);
      const caller = digitsOf(opts.callerId ?? null);
      if (caller) {
        const seen = this.callers.get(caller) ?? new Map<string, number>();
        if (!seen.has(callId)) seen.set(callId, this.now());
        this.callers.set(caller, seen);
      }
    }
    this.calls.delete(key); // re-insert so Map order stays oldest-first for prune()
    this.calls.set(key, s);
  }

  private capFor(callId: string, tool: string, callerId: string | null): number {
    const cap = tool === "alert_on_call_plumber" ? MAX_PER_CALL : MAX_OTHER_PER_CALL;
    const seen = this.callers.get(digitsOf(callerId));
    if (!seen) return cap;
    const others = [...seen.entries()].filter(([id, at]) => id !== callId && this.now() - at < HOUR_MS).length;
    return others >= CALLER_CALLS_PER_HOUR ? Math.min(cap, REPEAT_CALLER_CAP) : cap;
  }

  private prune() {
    const cutoff = this.now() - HOUR_MS;
    for (const [key, s] of this.calls) {
      if (s.at >= cutoff && this.calls.size <= MAX_TRACKED) break;
      this.calls.delete(key);
    }
    for (const [caller, seen] of this.callers) {
      for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
      if (!seen.size) this.callers.delete(caller);
    }
  }
}

/** What the assistant hears when a push was held. Never "sent": this one wasn't. Never ALERT_FAILED either, because
 * the plumber did get this call's earlier alert, and the prompt reads an error as "nobody was told". */
export function heldReply(toolCallId: unknown, why: Held, failed: string) {
  if (why === "dead_channel") return { toolCallId, error: failed };
  const note = why === "duplicate"
    ? "Not sent again: the plumber already has exactly this from earlier in the call."
    : "Not sent: the plumber already has this call and its updates, the most one call can send. Any new details " +
      "go to them in the call summary when the call ends.";
  return { toolCallId, result: `${note} Carry on from where you were; don't use the tool again for this.` };
}
