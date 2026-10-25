// Input bounds and log hygiene (security review M3, L6). Runs under plain Node:
//   node --test tests/*.test.ts
// The full system also checks the booking, Airtable and Sheets modules this way; those modules aren't in this repo.
import assert from "node:assert/strict";
import { test } from "node:test";

import { noMaskedLinks, push } from "../src/alert.ts";
import { apiError, clipArgs, errText, MAX_BODY_BYTES, pgError, redactQuoted, tooLarge } from "../src/safety.ts";

// Everything console.error and console.log were handed while fn ran, as one string.
async function logged(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const [error, log] = [console.error, console.log];
  console.error = console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { [console.error, console.log] = [error, log]; }
  return lines.join("\n");
}

const PII = ["415 555 0199", "Dana", "1847 41st Avenue"];
const assertNoPii = (s: string) => { for (const p of PII) assert.ok(!s.includes(p), `log contains "${p}": ${s}`); };

test("a body over the limit is refused before parsing; a missing or odd content-length isn't", () => {
  assert.equal(tooLarge(String(MAX_BODY_BYTES + 1)), true);
  assert.equal(tooLarge(String(MAX_BODY_BYTES)), false);
  assert.equal(tooLarge("250000"), false); // a long call's end-of-call report
  assert.equal(tooLarge(null), false); // chunked: the webhook checks the text's length instead
  assert.equal(tooLarge("abc"), false);
});

test("tool arguments are cut to their bounds; short ones and non-strings are untouched", () => {
  const a = clipArgs({ problem: "p".repeat(5000), caller_name: "n".repeat(500), callback_number: "4".repeat(200),
    address: "1847 41st Avenue", other: "x".repeat(9000), urgent: true, n: 3 });
  assert.equal((a.problem as string).length, 500);
  assert.equal((a.caller_name as string).length, 80);
  assert.equal((a.callback_number as string).length, 40);
  assert.equal(a.address, "1847 41st Avenue");
  assert.equal((a.other as string).length, 500);
  assert.equal(a.urgent, true);
  assert.equal(a.n, 3);
});

test("a failed call-log insert logs the code and message, never the failing row", () => {
  const body = JSON.stringify({
    code: "23514",
    message: 'new row for relation "demo_calls" violates check constraint "demo_calls_kind_check"',
    details: `Failing row contains (abc, emergency_alert, ${PII.join(", ")}, full transcript here).`,
    hint: null,
  });
  const line = pgError(400, body);
  assert.equal(line, '400 23514 new row for relation "demo_calls" violates check constraint "demo_calls_kind_check"');
  assertNoPii(line);
  assert.equal(pgError(500, "<html>bad gateway</html>"), "500");
});

test("quoted values in a Postgres message are dropped; quoted identifiers are kept", () => {
  assert.equal(redactQuoted('invalid input syntax for type uuid: "415 555 0199"'), 'invalid input syntax for type uuid: "…"');
  assert.equal(redactQuoted('column "caller_name" of relation "demo_calls"'), 'column "caller_name" of relation "demo_calls"');
});

test("third-party errors log the status and a code, never the message (which can quote what the caller said)", () => {
  assert.equal(apiError(422, JSON.stringify({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: `Field "Phone" cannot accept "${PII[0]}"` } })),
    "422 INVALID_VALUE_FOR_COLUMN");
  assert.equal(apiError(400, JSON.stringify({ status: "error", error: { code: "BadRequestException", message: `attendee ${PII[1]}` } })),
    "400 BadRequestException");
  assert.equal(apiError(400, JSON.stringify({ error: `attendee ${PII[1]} is invalid` })), "400"); // not code-shaped
  assert.equal(apiError(429, "rate limited"), "429");
});

test("errors are logged without URLs (Deno's fetch errors print the webhook URL, which is a secret)", () => {
  const e = new TypeError("error sending request for url (https://discord.com/api/webhooks/123/SECRETTOKEN): connection reset");
  const s = errText(e);
  assert.ok(!s.includes("SECRETTOKEN") && !s.includes("discord.com"), s);
  assert.match(s, /TypeError: error sending request for url \(<url>/);
  assert.ok(errText("x".repeat(1000)).length <= 200);
});

test("a failed alert send logs no URL and no upstream body", async () => {
  const channels = async () => ({ discord_webhook_url: "https://discord.com/api/webhooks/123/SECRETTOKEN", ntfy_topic: "secret-topic" });
  const out = await logged(() => push(channels, "EMERGENCY - Demo", `WATER\nCall back: ${PII[0]}`, "urgent", "x", async (url) => {
    if (url.includes("discord")) throw new TypeError(`error sending request for url (${url})`);
    return new Response(`{"error":"bad request: ${PII[1]}"}`, { status: 400 });
  }));
  assert.match(out, /discord failed/);
  assert.match(out, /ntfy failed 400/);
  assert.ok(!out.includes("SECRETTOKEN") && !out.includes("secret-topic"), out);
  assertNoPii(out);
});

test("caller-dictated text can't become a masked link in Discord, and still reads the same", async () => {
  assert.equal(noMaskedLinks("[pay here](https://evil.example)"), "[pay here]​(https://evil.example)");
  assert.equal(noMaskedLinks('Where: 1847 41st Avenue (caller said: "18 47")'), 'Where: 1847 41st Avenue (caller said: "18 47")');
  let content = "";
  await push(async () => ({ discord_webhook_url: "https://discord.example/hook" }), "EMERGENCY - Demo", "Name: [click](https://evil.example)",
    "urgent", "x", async (_url, init) => { content = JSON.parse(String(init.body)).content; return new Response(null, { status: 204 }); });
  assert.ok(!content.includes("](https://"), content);
});
