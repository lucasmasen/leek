// Copyright (c) 2026 Lucas Masen. All rights reserved. Not open source: see LICENSE.
// Input bounds and log hygiene (security review M3 and L6, 10/25).
//
// Bounds: a request body over MAX_BODY_BYTES is refused before it's parsed, and every string a tool call carries
// is cut to a length a real call never needs, so neither a Discord post nor a demo_calls row can be stuffed.
//
// Logs: Supabase function logs sit outside RLS and any retention policy, so what goes in them is only a status and
// a short reason. Never an upstream error body (PostgREST's "Failing row contains (...)" is the whole row, transcript
// included; Airtable and Cal.com echo field values back), and never a URL (Deno's fetch errors print the URL, and a
// Discord webhook URL or an ntfy topic is a secret).
//
// No Deno.* calls here, so tests/node/safety.test.ts can run it under plain Node.

type Json = Record<string, unknown>;

// A real Vapi body (a 10-minute call's end-of-call report, with the assistant config and every message) is a few
// hundred KB at most. Generous on purpose: refusing a real tool call would mean telling a caller nobody was told.
export const MAX_BODY_BYTES = 2_000_000;

export function tooLarge(contentLength: string | null): boolean {
  const n = Number(contentLength);
  return contentLength !== null && Number.isFinite(n) && n > MAX_BODY_BYTES;
}

// Per argument; anything not listed gets DEFAULT_ARG_LEN.
const ARG_LEN: Record<string, number> = {
  problem: 500, message: 1000, reason: 300, address: 200, address_as_said: 200, caller_name: 80,
  callback_number: 40, kind: 20, start: 60,
};
const DEFAULT_ARG_LEN = 500;

/** A copy of a tool call's arguments with every string cut to its bound. Non-strings pass through. */
export function clipArgs(args: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? v.slice(0, ARG_LEN[k] ?? DEFAULT_ARG_LEN) : v;
  return out;
}

/** An error as one short line, with any URL in it replaced. */
export function errText(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200);
}

// Postgres quotes identifiers ("demo_calls_kind_check") and values ("415 555 0199") the same way. Keep the ones that
// look like identifiers, which is what makes an error useful, and drop the rest.
const IDENT = /^[a-z_][a-z0-9_]*$/;
export const redactQuoted = (s: string) => s.replace(/"([^"]*)"/g, (m, inner: string) => (IDENT.test(inner) ? m : '"…"'));

/** A failed PostgREST call as `<status> <code> <message>`. `details` (the failing row) and `hint` are dropped. */
export function pgError(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as Json;
    const code = typeof j.code === "string" ? j.code.slice(0, 20) : "";
    const message = typeof j.message === "string" ? redactQuoted(j.message).slice(0, 200) : "";
    return [status, code, message].filter(Boolean).join(" ");
  } catch {
    return String(status);
  }
}

/** A failed third-party call (Cal.com, Airtable, Discord, ntfy) as its status plus an error code if the body has one
 * that looks like a code (INVALID_VALUE_FOR_COLUMN, BadRequestException). Never the message, which can quote values. */
export function apiError(status: number, body: string): string {
  let code = "";
  try {
    const j = JSON.parse(body) as Json;
    const e = j.error && typeof j.error === "object" ? (j.error as Json) : j;
    const c = e.code ?? e.type ?? (typeof j.error === "string" ? j.error : undefined);
    if (typeof c === "string" || typeof c === "number") code = String(c);
  } catch { /* not JSON: status only */ }
  return /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? `${status} ${code}` : String(status);
}
