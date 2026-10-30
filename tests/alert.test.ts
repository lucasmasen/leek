// The owner-alert logic the edge function uses. Runs under plain Node (no Deno needed):
//   node --test tests/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_FAILED, ALERT_SENT, alertNumber, alertOutcome, MESSAGE_FAILED, MESSAGE_SENT, PERSON_REQUEST_FAILED, PERSON_REQUEST_SENT, push, sentWithNumber, spokenNumber, toolReply } from "../src/alert.ts";

const BOTH = async () => ({ discord_webhook_url: "https://discord.example/hook", ntfy_topic: "t" });
const DISCORD_ONLY = async () => ({ discord_webhook_url: "https://discord.example/hook" });
const res = (code: number) => new Response(code === 204 ? null : "", { status: code }); // 204 may not carry a body
const status = (code: number) => async () => res(code);
const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => { console.error = original; };
};

async function reply(channels: Parameters<typeof push>[0], fetchFn: Parameters<typeof push>[5]) {
  const restore = quiet();
  try {
    const delivered = await push(channels, "EMERGENCY - Demo Plumbing", "WATER: burst pipe", "urgent", "x", fetchFn);
    return { delivered, ...toolReply("call_1", delivered) };
  } finally {
    restore();
  }
}

test("no channel configured: error, not 'alert sent'", async () => {
  let called = false;
  const r = await reply(async () => ({}), async () => { called = true; return new Response(""); });
  assert.equal(called, false);
  assert.equal(r.delivered, 0);
  assert.deepEqual(r, { delivered: 0, toolCallId: "call_1", error: ALERT_FAILED });
});

test("Discord returns 500: error", async () => {
  const r = await reply(DISCORD_ONLY, status(500));
  assert.equal(r.delivered, 0);
  assert.equal(r.error, ALERT_FAILED);
  assert.equal("result" in r, false);
});

test("fetch throws (network down, timeout): error, and push doesn't throw", async () => {
  const r = await reply(BOTH, async () => { throw new TypeError("network down"); });
  assert.equal(r.delivered, 0);
  assert.equal(r.error, ALERT_FAILED);
});

test("settings can't be read: error", async () => {
  const r = await reply(async () => { throw new Error("db down"); }, status(200));
  assert.equal(r.delivered, 0);
  assert.equal(r.error, ALERT_FAILED);
});

test("one of two channels delivers: result", async () => {
  const r = await reply(BOTH, async (url) => res(url.includes("discord") ? 204 : 429));
  assert.equal(r.delivered, 1);
  assert.deepEqual(r, { delivered: 1, toolCallId: "call_1", result: ALERT_SENT });
});

test("both channels deliver: counted twice, result", async () => {
  const r = await reply(BOTH, status(200));
  assert.equal(r.delivered, 2);
  assert.equal(r.result, ALERT_SENT);
});

test("every send carries a timeout so the tool answers inside Vapi's 20 s", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  await reply(BOTH, async (_url, init) => { signals.push(init.signal); return new Response(""); });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});

test("row outcome says whether it got through", () => {
  assert.equal(alertOutcome(0), "ALERT FAILED");
  assert.equal(alertOutcome(1), "alert delivered");
});

test("a person request uses its own success text, and the same error when nobody was told", async () => {
  assert.deepEqual(toolReply("t1", 1, PERSON_REQUEST_SENT), { toolCallId: "t1", result: PERSON_REQUEST_SENT });
  assert.deepEqual(toolReply("t1", 0, PERSON_REQUEST_SENT), { toolCallId: "t1", error: ALERT_FAILED });
});

test("after an alert, the webhook spells the number it sent, so the read-back matches the alert (QA E1)", async () => {
  const { alertSent, readBack } = await import("../src/alert.ts");
  assert.equal(readBack("4155550199"), "four one five, five five five, zero one nine nine");
  assert.equal(readBack("14155590172"), "four one five, five five nine, zero one seven two");
  const full = alertSent("415 555 0199", "+14155550172");
  assert.ok(full.startsWith(ALERT_SENT));
  assert.match(full, /exactly like this: "four one five, five five five, zero one nine nine\. Did I get that right\?"/);
  assert.match(alertSent("415 555 01", null), /I got four one five five five five zero one\. What comes after that\?/);
  assert.match(alertSent(null, "+14155550172"), /And is this number a good one to reach you at\?/);
  assert.match(alertSent(null, null), /no callback number yet/);

  assert.equal(alertNumber(null, "Update: caller's number is 415-555-0199, main is off"), "415-555-0199");
  assert.equal(alertNumber("4155550111", "number 415-555-0199"), "4155550111");
  assert.equal(alertNumber(null, "Burst pipe at 1450 Irving Street"), null);
  assert.match(alertSent(null, "+14155550172", "water", "Update: address 1450 Irving"), /The update is with them/);
  const gas = alertSent(null, "+14155550172", "gas");
  assert.match(gas, /911 or PG&E/);
  assert.doesNotMatch(gas, /water/); // not "help them stop the water" on a gas call
});

test("digits that are just the address are never taken as a callback number", () => {
  assert.equal(alertNumber("145016", "Update: confirmed address", "1450 Irving Street, near 16th"), null);
  assert.equal(alertNumber("4155550199", "Update", "1450 Irving Street, near 16th"), "4155550199");
  assert.equal(alertNumber("415555", "Update", "1450 Irving Street"), "415555"); // a partial number is still a number
  assert.equal(alertNumber("145016", "caller's number is 415-555-0199", "1450 Irving, near 16th"), "415-555-0199");
});

test("the caller's last spoken number backs up an alert that carries none", () => {
  const messages = [
    { role: "system", message: "Call 415 555 0000 never" },
    { role: "bot", message: "And is this number a good one to reach you at?" },
    { role: "user", message: "Yes, 415-555-0199 is good. I'm at 1450 Irving Street." },
    { role: "bot", message: "Fourteen fifty, Irving Street, right?" },
    { role: "user", message: "Yes, that's it, ground floor." },
  ];
  assert.equal(spokenNumber(messages), "415-555-0199");
  assert.equal(spokenNumber([{ role: "user", message: "Actually use 5105550123 instead" }]), "5105550123");
  assert.equal(spokenNumber([{ role: "user", message: "It's 1450 Irving, near 16th" }]), null); // an address isn't a number
  assert.equal(spokenNumber(undefined), null);
});

test("a failed message or person request says what failed, not 'ALERT FAILED'", () => {
  assert.deepEqual(toolReply("t", 0, "sent", MESSAGE_FAILED), { toolCallId: "t", error: MESSAGE_FAILED });
  assert.deepEqual(toolReply("t", 0, "sent", PERSON_REQUEST_FAILED), { toolCallId: "t", error: PERSON_REQUEST_FAILED });
  assert.deepEqual(toolReply("t", 0), { toolCallId: "t", error: ALERT_FAILED }); // alerts keep the alert failure
  assert.match(MESSAGE_FAILED, /Don't say the office will call/);
});

test("callback request and message replies spell the number that was sent (red-team 10/25)", () => {
  assert.equal(sentWithNumber(PERSON_REQUEST_SENT, "1 415 555 0172"),
    `${PERSON_REQUEST_SENT} Its callback number is four one five, five five five, zero one seven two. Whenever you ` +
    `read the number back, now or later, say exactly "four one five, five five five, zero one seven two". If they ` +
    "correct it, use this tool again with the corrected number.");
  assert.match(sentWithNumber(MESSAGE_SENT, "(415) 555-0172"), /four one five, five five five, zero one seven two/);
  assert.match(sentWithNumber(MESSAGE_SENT, "415 55"), /only part of one\. Say "I got four one five five five\. What comes after that\?"/);
  assert.equal(sentWithNumber(PERSON_REQUEST_SENT, null), PERSON_REQUEST_SENT);
  assert.equal(sentWithNumber(MESSAGE_SENT, "none"), MESSAGE_SENT);
});

// The five-line call summary, with the caller's words in quotes and
// " · " before the access details, reaches both channels exactly as the webhook built it.
test("the five-line call summary passes through to ntfy and Discord unchanged", async () => {
  const body = [
    "EMERGENCY: Dana",
    "Call back: 4155550166",
    "Where: 1847 41st Avenue (said \"18 47 40 first\") · back door, gate code 2468",
    "Problem: Burst pipe under toilet; valve off, water stopped",
    "Promised: NOT SENT: alert failed; plumber calls back within 15 min; keep valve off",
  ].join("\n");
  const sent: Record<string, string> = {};
  const delivered = await push(BOTH, "Call summary - Demo Plumbing", body, "high", "telephone_receiver", async (url, init) => {
    sent[String(url).includes("ntfy") ? "ntfy" : "discord"] = String(init?.body);
    return res(200);
  });
  assert.equal(delivered, 2);
  assert.equal(sent.ntfy, body);
  assert.equal(JSON.parse(sent.discord).content, `**\u{1F4DE} Call summary - Demo Plumbing**\n${body}`);
});
