// Direct mode (no waitlist): Ricky's worker. Every message is sent immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECRET, ghl, json, startRelay } from "./helpers.js";

async function withRelay(opts, fn) {
  const relay = await startRelay(opts);
  try {
    await fn(relay);
  } finally {
    await relay.dispose();
  }
}

test("forwards customData.to and customData.text to ZeroSettle and logs both sides", () =>
  withRelay({ zeroSettle: () => json(200, { ok: true, id: "msg_1" }) }, async (relay) => {
    const res = await relay.post(ghl(1, { to: "+15559876543", text: "Hi Jane!" }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: "msg_1" });
    const [call] = relay.zeroSettleCalls();
    assert.equal(relay.calls.length, 1);
    assert.equal(call.url, "https://portal.zerosettle.io/api/imessage/send");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "Bearer zs_test_key");
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, { to: "+15559876543", text: "Hi Jane!" });

    await waitFor(() => relay.logs.join("").includes("ZeroSettle response: 200"));
    const logs = relay.logs.join("");
    assert.match(logs, /Incoming payload: .*Hi Jane!/);
  }));

test("sends from the line in ZEROSETTLE_LINE_ID when it is set", () =>
  withRelay({ bindings: { ZEROSETTLE_LINE_ID: "ln_5e26a0ae50f4ea21" } }, async (relay) => {
    assert.equal((await relay.post(ghl(1))).status, 200);
    assert.deepEqual(relay.zeroSettleCalls()[0].body, {
      to: "+15550000001",
      text: "Hi Lead1!",
      line_id: "ln_5e26a0ae50f4ea21",
    });
  }));

test("falls back to the top-level phone when customData.to is missing or blank", () =>
  withRelay({}, async (relay) => {
    for (const customData of [{ text: "Hello" }, { to: "  ", text: "Hello" }]) {
      const body = ghl(1);
      body.customData = customData;
      const res = await relay.post(body);
      assert.equal(res.status, 200);
    }
    assert.deepEqual(
      relay.zeroSettleCalls().map((c) => c.body),
      [
        { to: "+15550000001", text: "Hello" },
        { to: "+15550000001", text: "Hello" },
      ],
    );
  }));

test("passes ZeroSettle's error status and body back to the caller", () =>
  withRelay({ zeroSettle: () => json(422, { error: "invalid number" }) }, async (relay) => {
    const res = await relay.post(ghl(1, { to: "bad" }));
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "invalid number" });
  }));

test("sends every message straight away, with no daily limit", () =>
  withRelay({}, async (relay) => {
    for (let n = 1; n <= 7; n++) assert.equal((await relay.post(ghl(n))).status, 200);
    assert.equal(relay.zeroSettleCalls().length, 7);
  }));

test("rejects requests without the right x-relay-secret header with 401", () =>
  withRelay({}, async (relay) => {
    for (const headers of [{}, { "x-relay-secret": "wrong" }, { "x-relay-secret": "" }]) {
      assert.equal((await relay.post(ghl(1), { headers })).status, 401);
    }
    assert.equal(relay.calls.length, 0);
  }));

test("rejects everything with 401 when RELAY_SECRET is not configured", () =>
  withRelay({ bindings: { RELAY_SECRET: "" } }, async (relay) => {
    assert.equal((await relay.post(ghl(1), { headers: { "x-relay-secret": "" } })).status, 401);
    assert.equal(relay.calls.length, 0);
  }));

test("returns 400 without calling ZeroSettle when text is missing", () =>
  withRelay({}, async (relay) => {
    const body = ghl(1);
    delete body.customData.text;
    const res = await relay.post(body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /text/);
    assert.equal(relay.calls.length, 0);
  }));

test("returns 400 for a body that isn't JSON, and 405 for non-POST requests", () =>
  withRelay({}, async (relay) => {
    assert.equal((await relay.post("not json")).status, 400);
    const get = await relay.fetch("https://relay.test/", { headers: { "x-relay-secret": SECRET } });
    assert.equal(get.status, 405);
    assert.equal(relay.calls.length, 0);
  }));

test("returns 500 with a clear message when ZEROSETTLE_API_KEY is not set", () =>
  withRelay({ bindings: { ZEROSETTLE_API_KEY: "" } }, async (relay) => {
    const res = await relay.post(ghl(1));
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /ZEROSETTLE_API_KEY/);
    assert.equal(relay.calls.length, 0);
  }));

test("handles an empty-body upstream status like 204", () =>
  withRelay({ zeroSettle: () => new Response(null, { status: 204 }) }, async (relay) => {
    assert.equal((await relay.post(ghl(1))).status, 204);
  }));

async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
