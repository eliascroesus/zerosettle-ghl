import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const URL = "https://relay.example.workers.dev/";
const ENV = { RELAY_SECRET: "s3cret-value", ZEROSETTLE_API_KEY: "zs_test_key" };

// Shape of GoHighLevel's standard Webhook action payload (trimmed).
const ghlPayload = (customData) => ({
  contact_id: "abc123",
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  workflow: { id: "wf1", name: "Send iMessage" },
  customData,
});

const post = (body, headers = { "x-relay-secret": ENV.RELAY_SECRET }) =>
  new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let realFetch;
let realLog;
let calls;
let logs;
let upstreamResponse;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realLog = console.log;
  calls = [];
  logs = [];
  upstreamResponse = () =>
    new Response(JSON.stringify({ ok: true, id: "msg_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return upstreamResponse();
  };
  console.log = (...args) => logs.push(args.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

test("forwards customData.to and customData.text to ZeroSettle", async () => {
  const res = await worker.fetch(post(ghlPayload({ to: "+15559876543", text: "Hi Jane!" })), ENV);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: "msg_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://portal.zerosettle.io/api/imessage/send");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer zs_test_key");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: "+15559876543", text: "Hi Jane!" });
  assert.ok(logs.some((l) => l.startsWith("Incoming payload:") && l.includes("Hi Jane!")));
  assert.ok(logs.some((l) => l.startsWith("ZeroSettle response: 200")));
});

test("falls back to top-level phone when customData.to is missing or blank", async () => {
  for (const customData of [{ text: "Hello" }, { to: "  ", text: "Hello" }]) {
    calls = [];
    const res = await worker.fetch(post(ghlPayload(customData)), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(calls[0].init.body), { to: "+15551234567", text: "Hello" });
  }
});

test("passes ZeroSettle's error status and body back to the caller", async () => {
  upstreamResponse = () =>
    new Response(JSON.stringify({ error: "invalid number" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  const res = await worker.fetch(post(ghlPayload({ to: "bad", text: "Hi" })), ENV);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "invalid number" });
  assert.ok(logs.some((l) => l.startsWith("ZeroSettle response: 422")));
});

test("rejects requests without the right x-relay-secret header with 401", async () => {
  const body = ghlPayload({ to: "+15559876543", text: "Hi" });
  for (const headers of [{}, { "x-relay-secret": "wrong" }, { "x-relay-secret": "" }]) {
    const res = await worker.fetch(post(body, headers), ENV);
    assert.equal(res.status, 401);
  }
  assert.equal(calls.length, 0);
});

test("rejects everything with 401 when RELAY_SECRET is not configured", async () => {
  const res = await worker.fetch(post(ghlPayload({ to: "+1", text: "Hi" }), { "x-relay-secret": "" }), {
    ZEROSETTLE_API_KEY: "k",
  });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("returns 400 without calling ZeroSettle when text is missing", async () => {
  const res = await worker.fetch(post(ghlPayload({ to: "+15559876543" })), ENV);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text/);
  assert.equal(calls.length, 0);
});

test("returns 400 for a body that isn't JSON", async () => {
  const res = await worker.fetch(post("not json"), ENV);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("returns 405 for non-POST requests", async () => {
  const res = await worker.fetch(new Request(URL, { method: "GET" }), ENV);
  assert.equal(res.status, 405);
});

test("returns 500 with a clear message when ZEROSETTLE_API_KEY is not set", async () => {
  const res = await worker.fetch(post(ghlPayload({ to: "+1", text: "Hi" })), { RELAY_SECRET: ENV.RELAY_SECRET });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /ZEROSETTLE_API_KEY/);
  assert.equal(calls.length, 0);
});

test("returns 502 when ZeroSettle can't be reached", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const res = await worker.fetch(post(ghlPayload({ to: "+1", text: "Hi" })), ENV);
  assert.equal(res.status, 502);
});

test("handles an empty-body upstream status like 204", async () => {
  upstreamResponse = () => new Response(null, { status: 204 });
  const res = await worker.fetch(post(ghlPayload({ to: "+1", text: "Hi" })), ENV);
  assert.equal(res.status, 204);
});
