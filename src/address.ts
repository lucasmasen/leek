// Copyright (c) 2026 Lucas Masen. All rights reserved. Not open source: see LICENSE.
// Street addresses, worked out by code instead of by the model.
//
// Speech-to-text splits San Francisco's numbered avenues ("41st" arrives as "40 first") and house numbers
// ("1847" arrives as "18 47"), and the model, asked to fix that itself, guessed: on test calls it sent 40th
// for 41st, then 41st for a caller who really said 40th, and once read 1847 as 1874 (10/23). A plumber at
// the wrong house loses the shop the job. So the check_address tool gives the caller's words to
// normalizeAddress(), and the assistant reads back exactly the words it returns.
//
// No Deno.* calls here, so tests/node/address.test.ts can run it under plain Node.

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORD_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19,
};
const ORD_TENS: Record<string, number> = { twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50 };

export const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

/** 0 to 99 in words: 41 -> "forty-one". */
function words99(n: number): string {
  if (n < 20) return UNITS[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${UNITS[n % 10]}` : "");
}

const ORD_WORD: Record<number, string> = Object.fromEntries(Object.entries(ORD_UNITS).map(([w, n]) => [n, w]));

/** 41 -> "forty-first", 23 -> "twenty-third", 40 -> "fortieth", 12 -> "twelfth". */
export function ordinalWords(n: number): string {
  if (n < 20) return ORD_WORD[n];
  if (n % 10 === 0) return TENS[n / 10].replace(/y$/, "ieth");
  return `${TENS[Math.floor(n / 10)]}-${ORD_WORD[n % 10]}`;
}

/** House numbers the way people say them: 1847 -> "eighteen forty-seven", 2250 -> "twenty-two fifty",
 * 1500 -> "fifteen hundred", 1505 -> "fifteen oh five", 345 -> "three forty-five", 40 -> "forty". */
export function houseNumberWords(n: number): string {
  if (n < 100) return words99(n);
  const hi = Math.floor(n / 100), lo = n % 100;
  if (n >= 10000) return String(n).split("").map((d) => UNITS[Number(d)]).join(" ");
  if (lo === 0) return `${words99(hi)} hundred`;
  return `${words99(hi)} ${lo < 10 ? `oh ${UNITS[lo]}` : words99(lo)}`;
}

// Spoken numbers to digits, keeping ordinal words: "eighteen forty seven forty first" -> "18 47 40 first".
function wordsToDigits(s: string): string {
  const units = new Map(UNITS.map((w, i) => [w, i]));
  const tens = new Map(TENS.map((w, i) => [w, i * 10]).filter(([w]) => w) as [string, number][]);
  const out: string[] = [];
  const toks = s.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const [a, b] = t.split("-");
    if (tens.has(a) && b && units.has(b)) { out.push(String(tens.get(a)! + units.get(b)!)); continue; }
    if (tens.has(a) && b && b in ORD_UNITS) { out.push(String(tens.get(a)!), b); continue; }
    if (tens.has(t) && units.has(toks[i + 1] ?? "") && units.get(toks[i + 1])! < 10) {
      out.push(String(tens.get(t)! + units.get(toks[i + 1])!)); i++; continue;
    }
    if (tens.has(t)) { out.push(String(tens.get(t))); continue; }
    if (units.has(t)) { out.push(String(units.get(t))); continue; }
    if (t === "hundred" && out.length && /^\d+$/.test(out[out.length - 1])) { out.push("00"); continue; }
    if (t === "oh" && out.length && /^\d+$/.test(out[out.length - 1])) { out.push("0"); continue; }
    out.push(t);
  }
  return out.join(" ");
}

const STREET_TYPES: Record<string, string> = {
  ave: "Avenue", av: "Avenue", avenue: "Avenue", st: "Street", street: "Street", blvd: "Boulevard",
  boulevard: "Boulevard", way: "Way", dr: "Drive", drive: "Drive", ct: "Court", court: "Court", pl: "Place",
  place: "Place", ln: "Lane", lane: "Lane", ter: "Terrace", terrace: "Terrace", rd: "Road", road: "Road",
};
const FILLER = /^(uh+|um+|so|yeah|yes|it's|its|it|is|the|address|my|our|at|we're|i'm|i|live|on|it’s)$/;

export type Address = { address: string; spoken: string; sure: boolean; note?: string };

/** The caller's words -> a written address ("1847 41st Avenue"), how to read it back ("eighteen forty-seven,
 * forty-first Avenue"), and whether the code is sure. Anything after the street (", near Lawton",
 * "in the Sunset") is kept as written. */
export function normalizeAddress(said: string): Address {
  let s = said.toLowerCase().replace(/[.,!?;:]+/g, " ").replace(/(\d)-(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
  s = wordsToDigits(s);
  // "1 8 4 7" said digit by digit, and "15 00" from "fifteen hundred"
  s = s.replace(/\b(\d)\s(\d)\s(\d)\s(\d)\b/g, "$1$2$3$4").replace(/\b(\d{1,2}) 00\b/g, "$100").replace(/\b(\d{1,2}) 0 (\d)\b/g, "$10$2");
  const toks = s.split(" ").filter(Boolean);
  let i = 0;
  while (i < toks.length && FILLER.test(toks[i])) i++; // "yeah it's the address is ..." up front only
  // House number: "1847", or two pairs "18 47" (people say four-digit numbers in pairs).
  let house: number | null = null;
  const ordTok = (t: string) => ORD_UNITS[t] ?? (/^(\d)(st|nd|rd|th)$/.test(t) ? Number(t[0]) : null);
  const splitOrdinalAt = (k: number) => /^[2-5]0$/.test(toks[k] ?? "") && ordTok(toks[k + 1] ?? "") !== null && ordTok(toks[k + 1])! < 10;
  // "40 first in Lawton" is 41st Avenue (a split ordinal), not house 40 on 1st Avenue.
  if (/^\d+$/.test(toks[i] ?? "") && !splitOrdinalAt(i)) {
    if (/^\d{2}$/.test(toks[i]) && /^\d{2}$/.test(toks[i + 1] ?? "") && isStreetNumberStart(toks, i + 2)) {
      house = Number(toks[i] + toks[i + 1]); i += 2;
    } else if (isStreetNumberStart(toks, i + 1) || isNamedStreet(toks, i + 1)) {
      house = Number(toks[i]); i += 1;
    }
  }
  // Numbered street: "41st", "40 first", "40 1st", "4 1st" (split ordinal), or "40" / "40th" on its own.
  let streetNum: number | null = null;
  let sure = true;
  const t0 = toks[i] ?? "", t1 = toks[i + 1] ?? "";
  if (splitOrdinalAt(i)) { streetNum = Number(t0) + ordTok(t1)!; i += 2; }
  else if (/^[2-4]$/.test(t0) && /^\d(st|nd|rd|th)$/.test(t1)) { streetNum = Number(t0 + t1[0]); i += 2; }
  else if (/^\d{1,2}(st|nd|rd|th)$/.test(t0)) { streetNum = parseInt(t0, 10); i += 1; }
  else if (t0 in ORD_UNITS) { streetNum = ORD_UNITS[t0]; i += 1; }
  else if (t0 in ORD_TENS) { streetNum = ORD_TENS[t0]; i += 1; }
  else if (/^\d{1,2}$/.test(t0) && STREET_TYPES[t1]) { streetNum = Number(t0); i += 1; sure = false; }
  let street: string;
  let spokenStreet: string;
  if (streetNum !== null) {
    const type = STREET_TYPES[toks[i] ?? ""] ?? "Avenue";
    if (STREET_TYPES[toks[i] ?? ""]) i += 1;
    street = `${ordinal(streetNum)} ${type}`;
    spokenStreet = `${ordinalWords(streetNum)} ${type}`;
  } else {
    const name: string[] = [];
    while (i < toks.length && !STREET_TYPES[toks[i]] && !/^(near|by|and|in|at|off|between|&)$/.test(toks[i])) name.push(toks[i++]);
    const type = STREET_TYPES[toks[i] ?? ""];
    if (type) i += 1;
    if (!name.length) return { address: said.trim(), spoken: said.trim(), sure: false, note: "no street found" };
    street = [...name.map(cap), type].filter(Boolean).join(" ");
    spokenStreet = street;
  }
  // "in Lawton" right after a street is a cross street ("and Lawton"); "in the Sunset" is a neighborhood.
  const rest = toks.slice(i).join(" ").replace(/^(in|&)\s(?!the\b)/, "and ").replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Near|By|And|In|At|Off|Between|The)\b/g, (m) => m.toLowerCase());
  const address = [house !== null ? `${house} ${street}` : street, rest].filter(Boolean).join(rest.startsWith("and") ? " " : ", ");
  const spoken = [house !== null ? `${houseNumberWords(house)}, ${spokenStreet}` : spokenStreet, rest].filter(Boolean)
    .join(rest.startsWith("and") ? " " : ", ");
  return { address, spoken, sure: sure && (house !== null || streetNum !== null || rest.startsWith("and")) };
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

function isStreetNumberStart(toks: string[], i: number): boolean {
  const t = toks[i] ?? "";
  return /^\d{1,2}(st|nd|rd|th)?$/.test(t) || t in ORD_UNITS || t in ORD_TENS;
}

function isNamedStreet(toks: string[], i: number): boolean {
  const t = toks[i] ?? "";
  return /^[a-z]/.test(t) && !(t in ORD_UNITS);
}

export const NO_ADDRESS_GIVEN =
  "Nothing was checked: address_as_said was empty. Call check_address again with address_as_said set to the " +
  "caller's address exactly as they said it. Until then, don't read back, send or book any address.";

/** check_address end to end: the caller's words in, what the assistant hears back out. */
export function checkAddress(said: unknown): string {
  const text = typeof said === "string" ? said.trim() : "";
  return text ? addressReply(normalizeAddress(text)) : NO_ADDRESS_GIVEN;
}

/** What the assistant hears back from check_address. */
export function addressReply(a: Address): string {
  const head = a.sure
    ? `Read it back once, exactly like this: "${a.spoken}, right?"`
    : `Not sure about this one. Read it back once, exactly like this, and ask them to correct anything: "I have ${a.spoken}. Is that right?"`;
  // Checking isn't sending: on prospect demos the model said "I've passed your address along" with no alert (10/24).
  return `${head} If they say yes, the address is "${a.address}": use exactly that wherever you send or book the address. ` +
    "On an emergency, once they say yes, send it to the plumber with the alert tool: an update with the address, plus " +
    "callback_number if they've said a phone number on this call. Do that before you say it's passed along. If they correct any part, call check_address again with their correction.";
}
