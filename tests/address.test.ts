// Addresses worked out by code (check_address). Plain Node:  node --test tests/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { addressReply, checkAddress, houseNumberWords, NO_ADDRESS_GIVEN, normalizeAddress, ordinalWords } from "../src/address.ts";

const SAME_HOUSE: [string, string][] = [
  // How "1847 41st Avenue" came through on real test calls (10/23) and the other ways speech-to-text splits it.
  ["Address is 18 47 40 first Avenue.", "1847 41st Avenue"],
  ["It's 1847 40 first avenue.", "1847 41st Avenue"],
  ["eighteen forty seven forty first avenue", "1847 41st Avenue"],
  ["1847, 41st Ave.", "1847 41st Avenue"],
  ["18 47, 4 1st avenue", "1847 41st Avenue"],
  ["1847 40 1st Ave", "1847 41st Avenue"],
  ["1 8 4 7 41st avenue", "1847 41st Avenue"],
  ["1847 forty first ave", "1847 41st Avenue"],
  ["1847 forty-first avenue near Lawton", "1847 41st Avenue, near Lawton"],
  ["yeah it's 18 47 40 first avenue in the sunset by lawton", "1847 41st Avenue, in the Sunset by Lawton"],
];

test("every way 1847 41st Avenue came through is 1847 41st Avenue", () => {
  for (const [said, want] of SAME_HOUSE) {
    const a = normalizeAddress(said);
    assert.equal(a.address, want, said);
    assert.ok(a.spoken.startsWith("eighteen forty-seven, forty-first Avenue"), said);
    assert.equal(a.sure, true, said);
  }
});

test("someone who really lives on 40th Avenue stays on 40th", () => {
  assert.equal(normalizeAddress("It's 1847 40th avenue.").address, "1847 40th Avenue");
  const bare = normalizeAddress("Address is 18 47 40 avenue.");
  assert.equal(bare.address, "1847 40th Avenue");
  assert.equal(bare.sure, false); // a bare "40" might have lost its "first": ask
  assert.match(addressReply(bare), /^Not sure about this one/);
});

test("other streets, cross streets and named streets", () => {
  for (const [said, want] of [
    ["1500 20 third avenue", "1500 23rd Avenue"], ["twenty two fifty twenty third avenue", "2250 23rd Avenue"],
    ["41st and Lawton", "41st Avenue and Lawton"], ["40 first in Lawton", "41st Avenue and Lawton"],
    ["forty first avenue and lawton", "41st Avenue and Lawton"], ["1450 Irving Street, near 16th Avenue", "1450 Irving Street, near 16th Avenue"],
    ["88 Judah Street", "88 Judah Street"], ["300 Clement St", "300 Clement Street"], ["It's 650 Valencia Street.", "650 Valencia Street"],
    ["fifteen hundred irving", "1500 Irving"],
  ] as [string, string][]) assert.equal(normalizeAddress(said).address, want, said);
});

test("numbers are read back the way people say them", () => {
  assert.equal(houseNumberWords(1847), "eighteen forty-seven");
  assert.equal(houseNumberWords(2250), "twenty-two fifty");
  assert.equal(houseNumberWords(1500), "fifteen hundred");
  assert.equal(houseNumberWords(1505), "fifteen oh five");
  assert.equal(houseNumberWords(650), "six fifty");
  assert.equal(ordinalWords(41), "forty-first");
  assert.equal(ordinalWords(40), "fortieth");
  assert.equal(ordinalWords(23), "twenty-third");
  assert.equal(ordinalWords(12), "twelfth");
});

test("called without the caller's words, it checks nothing and says so (suite, 10/23)", () => {
  for (const empty of [undefined, "", "   ", 42]) assert.equal(checkAddress(empty), NO_ADDRESS_GIVEN);
  assert.match(checkAddress("18 47 40 first Avenue"), /forty-first Avenue/);
});

test("the reply tells the assistant exactly what to say and what to send", () => {
  const r = addressReply(normalizeAddress("18 47 40 first Avenue"));
  assert.match(r, /exactly like this: "eighteen forty-seven, forty-first Avenue, right\?"/);
  assert.match(r, /the address is "1847 41st Avenue"/);
});
