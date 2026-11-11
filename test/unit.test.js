// Plain Node tests for the pieces that don't need the Workers runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localHour } from "../src/time.js";
import { phoneKey, readLead, safeEqual, sendToZeroSettle, zeroSettleResponse } from "../src/lib.js";

const NY = "America/New_York";

test("localHour gives New York time in summer (EDT) and winter (EST)", () => {
  assert.equal(localHour(Date.parse("2026-07-15T15:59:00Z"), NY), 11);
  assert.equal(localHour(Date.parse("2026-07-15T16:00:00Z"), NY), 12);
  assert.equal(localHour(Date.parse("2026-12-15T16:59:00Z"), NY), 11);
  assert.equal(localHour(Date.parse("2026-12-15T17:00:00Z"), NY), 12);
  assert.equal(localHour(Date.parse("2026-12-15T05:30:00Z"), NY), 0); // midnight is 0, not 24
});

test("readLead takes customData.to, falls back to phone, and picks up contact id and name", () => {
  assert.deepEqual(
    readLead({ contact_id: "c1", full_name: "Jane Doe", phone: "+1555", customData: { to: " +1666 ", text: "hi" } }),
    { to: "+1666", text: "hi", contactId: "c1", name: "Jane Doe" },
  );
  assert.equal(readLead({ phone: "+1555", customData: { text: "hi" } }).to, "+1555");
  assert.deepEqual(readLead(null), { to: "", text: "", contactId: "", name: "" });
});

test("phoneKey ignores formatting", () => {
  assert.equal(phoneKey("+1 (555) 000-0001"), "15550000001");
  assert.equal(phoneKey("+15550000001"), "15550000001");
});

test("safeEqual compares exactly", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});

test("an unreachable ZeroSettle becomes a 502 for the caller", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  console.log = () => {};
  try {
    const result = await sendToZeroSettle({ ZEROSETTLE_API_KEY: "k" }, "+1", "hi");
    assert.equal(result.status, 0);
    assert.equal(zeroSettleResponse(result).status, 502);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
});
