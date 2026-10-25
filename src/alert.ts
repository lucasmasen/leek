// Owner alerts: send to every configured channel and count how many actually delivered.
//
// No Deno.* calls here, so tests/node/alert.test.ts can run it under plain Node
// (`node --test tests/node/*.test.ts`). index.ts passes in the real settings and fetch.

export type Channels = { discord_webhook_url?: string; ntfy_topic?: string; ntfy_token?: string };
export type Priority = "urgent" | "high" | "default";
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const ALERT_SENT = "Alert sent to the on-call plumber.";
// The second sentence is there because the model, many turns later, still sometimes said "A plumber will call you
// back" after a failed alert (suite, 10/22).
export const ALERT_FAILED = "ALERT FAILED: nobody at the shop was notified. For the rest of this call, never say anyone will call them back or is on the way.";
const SEND_TIMEOUT_MS = 8000; // two channels in parallel still finish well inside Vapi's 20 s tool timeout

const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, "").slice(0, 120); // HTTP header values must be ASCII

// Returns how many channels delivered (a 2xx). Never throws: a send that errors, times out or
// gets a non-2xx counts as not delivered, and so does a failed settings read.
export async function push(
  channels: () => Promise<Channels>,
  title: string,
  body: string,
  priority: Priority,
  tags: string,
  fetchFn: Fetch = fetch,
): Promise<number> {
  let conf: Channels;
  try {
    conf = await channels();
  } catch (e) {
    console.error("alert: could not read channels", e);
    return 0;
  }
  const sends: Promise<boolean>[] = [];
  const send = (name: string, url: string, init: RequestInit) =>
    fetchFn(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
      .then(async (r) => {
        if (!r.ok) console.error(`${name} failed`, r.status, await r.text().catch(() => ""));
        return r.ok;
      })
      .catch((e) => {
        console.error(`${name} failed`, e);
        return false;
      });
  if (conf.discord_webhook_url) {
    const icon = priority === "urgent" ? "\u{1F6A8} " : "\u{1F4DE} ";
    sends.push(send("discord", conf.discord_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**${icon}${title}**\n${body}`.slice(0, 2000), allowed_mentions: { parse: [] } }),
    }));
  }
  if (conf.ntfy_topic) {
    const headers: Record<string, string> = { Title: ascii(title), Priority: priority, Tags: tags };
    if (conf.ntfy_token) headers.Authorization = `Bearer ${conf.ntfy_token}`;
    sends.push(send("ntfy", `https://ntfy.sh/${conf.ntfy_topic}`, { method: "POST", body, headers }));
  }
  if (!sends.length) console.error("no alert channel configured in demo_line_settings");
  return (await Promise.all(sends)).filter(Boolean).length;
}

// What the assistant hears back. Vapi puts `error` into the conversation and the model answers
// it; the prompt tells it an error means nobody was told, so it must not promise a callback.
export function toolReply(toolCallId: unknown, delivered: number, sent = ALERT_SENT) {
  return delivered > 0 ? { toolCallId, result: sent } : { toolCallId, error: ALERT_FAILED };
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const spell = (d: string) => [...d].map((c) => WORDS[Number(c)]).join(" ");

/** "four one five, five five five, zero one nine nine" for a 10-digit US number (a leading 1 dropped). */
export function readBack(digits: string): string {
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length !== 10) return spell(d);
  return `${spell(d.slice(0, 3))}, ${spell(d.slice(3, 6))}, ${spell(d.slice(6))}`;
}

/** The callback number in an alert: the callback_number argument, or else a full US number written into the
 * problem text (the model sometimes puts "caller's number is 415-555-0199" there instead). */
export function alertNumber(callbackArg: string | null, problem: string | null, address: string | null = null): string | null {
  // The model once put an address's digits in callback_number ("1450 Irving, near 16th" -> "145016", 10/24 suite);
  // the reply then asked the caller "what comes after that?". Digits that are just the address aren't a number.
  const digits = (callbackArg ?? "").replace(/\D/g, "");
  const addressDigits = (address ?? "").replace(/\D/g, "");
  if (callbackArg && digits.length < 10 && addressDigits && addressDigits.includes(digits)) callbackArg = null;
  if (callbackArg) return callbackArg;
  const m = (problem ?? "").match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  return m ? m[0] : null;
}

/** The last phone number the caller said out loud, from the conversation Vapi sends with each tool call
 * (artifact.messages). Prospect demos (10/24) left a spoken "yes, 415 555 0199 is good" off every update, so the
 * plumber would have called the wrong phone. Only used when the alert itself carries no number. */
export function spokenNumber(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || m.role !== "user") continue;
    const text = String(m.message ?? m.content ?? "");
    const found = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g);
    if (found) return found[found.length - 1];
  }
  return null;
}

/** What the assistant hears after an alert went through. The webhook, not the model, turns the number it
 * sent into words, so the read-back is exactly what the plumber got (QA E1, 10/21: the model read back one
 * number and sent another, and held the alert while it waited for a "yes"). */
export function alertSent(callbackArg: string | null, callerId: string | null, kind?: unknown, problem?: string | null): string {
  if (!callbackArg && /^\s*(update|correction)\b/i.test(problem ?? "")) {
    return `${ALERT_SENT} The update is with them. Carry on from where you were; don't ask again for anything you already have.`;
  }
  if (kind === "gas" && !callbackArg) {
    return `${ALERT_SENT} It has the number they're calling from. Keep them safe: everyone out, no switches or ` +
      "flames, call 911 or PG&E from outside. Only once they're outside, ask if the number they're calling from is " +
      "the best one to reach them.";
  }
  const digits = (callbackArg ?? "").replace(/\D/g, "");
  if (digits) {
    const n = digits.length === 11 && digits.startsWith("1") ? 10 : digits.length;
    if (n < 10) {
      return `${ALERT_SENT} The callback number so far is only part of one. Say "I got ${readBack(digits)}. What comes after that?" ` +
        "When you have the rest, use the alert tool again with the full number.";
    }
    return `${ALERT_SENT} Its callback number is ${readBack(digits)}. Read it back once, exactly like this: "${readBack(digits)}. ` +
      `Did I get that right?" If they correct it, use the alert tool again with the corrected number and "correction" in the problem.`;
  }
  if (callerId) {
    return `${ALERT_SENT} It has the number they're calling from. After the water steps, ask warmly and lightly, as a ` +
      `quick check: "And is this number a good one to reach you at?" If they say any phone number, even inside a yes ` +
      `("yes, 510 555 0123 is good"), it may not be this one: send it with the alert tool that same turn ` +
      "(callback_number, \"update\" in the problem) before you say anything about it.";
  }
  return `${ALERT_SENT} It has no callback number yet (caller ID is blocked). Ask for their number, then use the ` +
    "alert tool again with it and \"update\" in the problem.";
}

export const PERSON_REQUEST_SENT = "Request sent. The first person at the shop who's free will call them back.";

export const alertOutcome = (delivered: number) => (delivered > 0 ? "alert delivered" : "ALERT FAILED");
