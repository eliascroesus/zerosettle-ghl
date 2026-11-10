// Plain Node tests for the pieces that don't need the Workers runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { periodKey } from "../src/period.js";
import { phoneKey, readLead, safeEqual, sendToZeroSettle, zeroSettleResponse } from "../src/lib.js";

const NY = "America/New_York";

test("a sending day starts at noon New York time, in summer (EDT) and winter (EST)", () => {
  assert.equal(periodKey(Date.parse("2026-07-15T15:59:00Z"), NY, 12), "2026-07-14"); // 11:59am EDT
  assert.equal(periodKey(Date.parse("2026-07-15T16:00:00Z"), NY, 12), "2026-07-15"); // 12:00pm EDT
  assert.equal(periodKey(Date.parse("2026-12-15T16:59:00Z"), NY, 12), "2026-12-14"); // 11:59am EST
  assert.equal(periodKey(Date.parse("2026-12-15T17:00:00Z"), NY, 12), "2026-12-15"); // 12:00pm EST
});

test("sending days roll over month and year boundaries", () => {
  assert.equal(periodKey(Date.parse("2026-03-01T05:00:00Z"), NY, 12), "2026-02-28"); // midnight Mar 1
  assert.equal(periodKey(Date.parse("2027-01-01T16:00:00Z"), NY, 12), "2026-12-31"); // 11am Jan 1
  assert.equal(periodKey(Date.parse("2027-01-01T05:00:00Z"), NY, 0), "2027-01-01"); // midnight reset
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
