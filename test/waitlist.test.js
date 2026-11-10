// Waitlist mode (the trading worker). Tests use DAILY_LIMIT 2 to keep them short.
import { test } from "node:test";
import assert from "node:assert/strict";
import { day, ghl, json, phone, startRelay } from "./helpers.js";

async function withWaitlist(opts, fn) {
  const relay = await startRelay({ waitlist: true, ...opts });
  try {
    await fn(relay);
  } finally {
    await relay.dispose();
  }
}

/** Opt in leads one at a time (in order), so "newest" is well defined. */
async function optIn(relay, ...ns) {
  const out = [];
  for (const n of ns) out.push(await relay.post(ghl(n)));
  return out;
}

test("sends right away while today's slots last, then puts leads on the waitlist", () =>
  withWaitlist({}, async (relay) => {
    const [r1, r2, r3, r4] = await optIn(relay, 1, 2, 3, 4);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r1.json(), { ok: true }); // ZeroSettle's own answer
    assert.equal(r3.status, 202);
    assert.deepEqual(await r3.json(), { status: "waiting", position: 1, waiting: 1 });
    // Newest first: lead 4 jumps ahead of lead 3.
    assert.deepEqual(await r4.json(), { status: "waiting", position: 1, waiting: 2 });

    assert.deepEqual(relay.sentTo(), [phone(1), phone(2)]);
    assert.deepEqual(relay.tagCalls(), [
      "POST contact1 jean-imessage-sent",
      "DELETE contact1 jean-imessage-waiting,jean-imessage-priority",
      "POST contact2 jean-imessage-sent",
      "DELETE contact2 jean-imessage-waiting,jean-imessage-priority",
      "POST contact3 jean-imessage-waiting",
      "POST contact4 jean-imessage-waiting",
    ]);
  }));

test("at the daily reset, sends the waitlist newest first and keeps the rest waiting", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4, 5, 6);
    relay.clearCalls();

    // Hourly checks later the same day send nothing: no slots left.
    await relay.tick(Date.now());
    assert.deepEqual(relay.sentTo(), []);

    // Next sending day: 2 slots, newest opt-ins first.
    await relay.tick(day(1));
    assert.deepEqual(relay.sentTo(), [phone(6), phone(5)]);

    // Further checks that day don't send more.
    await relay.tick(day(1, 1));
    assert.deepEqual(relay.sentTo(), [phone(6), phone(5)]);

    // New opt-ins that day wait too (the waitlist used today's slots).
    assert.equal((await relay.post(ghl(7))).status, 202);

    // The day after: lead 7 is now the newest, then lead 4.
    await relay.tick(day(2));
    assert.deepEqual(relay.sentTo(), [phone(6), phone(5), phone(7), phone(4)]);
  }));

test("a lead who books a call jumps to the front of the waitlist", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4, 5);
    relay.clearCalls();

    // Lead 3 (in the middle of the waitlist) books a call, with no text in the booking webhook.
    const body = ghl(3);
    delete body.customData.text;
    const res = await relay.post(body, { path: "/booked" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: "waiting", position: 1, waiting: 3 });
    assert.deepEqual(relay.tagCalls(), ["POST contact3 jean-imessage-waiting,jean-imessage-priority"]);

    await relay.tick(day(1));
    // Booked lead first (with their original message), then the newest opt-in.
    assert.deepEqual(
      relay.zeroSettleCalls().map((c) => c.body),
      [
        { to: phone(3), text: "Hi Lead3!" },
        { to: phone(5), text: "Hi Lead5!" },
      ],
    );
    assert.ok(relay.tagCalls().includes("DELETE contact3 jean-imessage-waiting,jean-imessage-priority"));
  }));

test("a booking webhook's text replaces the lead's waiting message", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    await relay.post(ghl(3, { text: "Saw you booked a call!" }), { path: "/booked/" });
    relay.clearCalls();
    await relay.tick(day(1));
    assert.deepEqual(relay.zeroSettleCalls()[0].body, { to: phone(3), text: "Saw you booked a call!" });
  }));

test("a booked lead who never opted in is sent now if a slot is free, otherwise waits at the front", () =>
  withWaitlist({}, async (relay) => {
    const first = await relay.post(ghl(1, { text: "Booking msg" }), { path: "/booked" });
    assert.equal(first.status, 200);
    assert.deepEqual(relay.sentTo(), [phone(1)]);

    await optIn(relay, 2, 3); // 2 uses the last slot, 3 waits
    const booked = await relay.post(ghl(4, { text: "Booking msg" }), { path: "/booked" });
    assert.equal(booked.status, 202);
    assert.equal((await booked.json()).position, 1);
  }));

test("a booked lead without text who isn't on the waitlist is ignored", () =>
  withWaitlist({}, async (relay) => {
    const body = ghl(1);
    delete body.customData.text;
    const res = await relay.post(body, { path: "/booked" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ignored");
    assert.equal(relay.calls.length, 0);
  }));

test("booking a call after already being messaged does nothing", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1);
    relay.clearCalls();
    const res = await relay.post(ghl(1, { text: "Booking msg" }), { path: "/booked" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "already_sent" });
    assert.equal(relay.calls.length, 0);
  }));

test("follow-ups to someone already messaged go straight through without using a slot", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2); // both slots used
    const followUp = await relay.post(ghl(1, { text: "Following up!" }));
    assert.equal(followUp.status, 200);
    assert.deepEqual(relay.zeroSettleCalls().at(-1).body, { to: phone(1), text: "Following up!" });
    // Still no slot for a brand-new lead.
    assert.equal((await relay.post(ghl(3))).status, 202);
  }));

test("phone numbers in different formats count as the same person", () =>
  withWaitlist({}, async (relay) => {
    await relay.post(ghl(1, { to: "+1 (555) 000-0001" }));
    await relay.post(ghl(2, { to: "+15550000001", text: "Again" }));
    assert.equal(relay.zeroSettleCalls().length, 2); // second one is a follow-up
    assert.equal((await relay.post(ghl(3))).status, 200); // a slot was still free
  }));

test("more messages for a lead who is still waiting are skipped", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    const res = await relay.post(ghl(3, { text: "Second message" }));
    assert.equal(res.status, 202);
    assert.match((await res.json()).note, /skipped/);
    assert.equal(relay.calls.length, 0);

    await relay.tick(day(1));
    assert.deepEqual(relay.zeroSettleCalls()[0].body, { to: phone(3), text: "Hi Lead3!" });
  }));

test("if ZeroSettle says the daily limit is reached, the lead keeps their place", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1); // 1 of 2 slots used
    relay.setZeroSettle(() => json(429, { error: "Daily new conversation limit reached" }));
    const res = await relay.post(ghl(2));
    assert.equal(res.status, 202);
    assert.equal((await res.json()).status, "waiting");

    // Our counter now treats today as full: no more attempts today.
    relay.clearCalls();
    await relay.post(ghl(3));
    await relay.tick(Date.now());
    assert.equal(relay.zeroSettleCalls().length, 0);

    relay.setZeroSettle(() => json(200, { ok: true }));
    await relay.tick(day(1));
    assert.deepEqual(relay.sentTo(), [phone(3), phone(2)]);
  }));

test("a number ZeroSettle rejects is marked failed and the next lead gets the slot", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4);
    relay.clearCalls();
    relay.setZeroSettle((body) =>
      body.to === phone(4) ? json(400, { error: "invalid phone number" }) : json(200, { ok: true }),
    );
    await relay.tick(day(1));
    assert.deepEqual(relay.sentTo(), [phone(4), phone(3)]);
    assert.ok(relay.tagCalls().includes("POST contact4 jean-imessage-failed"));
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-sent"));
  }));

test("a temporary ZeroSettle outage keeps everyone waiting and retries hourly", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.setZeroSettle(() => json(503, { error: "unavailable" }));

    for (let h = 0; h < 4; h++) await relay.tick(day(1, h));
    assert.deepEqual(relay.sentTo(), [phone(3), phone(3), phone(3), phone(3)]); // one try per hour

    relay.setZeroSettle(() => json(200, { ok: true }));
    await relay.tick(day(1, 4));
    assert.equal(relay.sentTo().at(-1), phone(3));
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-sent"));
  }));

test("a lead whose sends keep failing temporarily is marked failed after 5 tries", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.setZeroSettle(() => json(503, { error: "unavailable" }));
    for (let h = 0; h < 5; h++) await relay.tick(day(1, h));
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-failed"));
  }));

test("a refused ZeroSettle API key doesn't use up anyone's tries", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.setZeroSettle(() => json(401, { error: "bad key" }));
    for (let h = 0; h < 8; h++) await relay.tick(day(1, h));
    assert.ok(!relay.tagCalls().some((t) => t.includes("failed")));

    relay.setZeroSettle(() => json(200, { ok: true }));
    await relay.tick(day(1, 9));
    assert.equal(relay.sentTo().at(-1), phone(3));
  }));

test("many opt-ins at the same moment never go over the daily limit", () =>
  withWaitlist({}, async (relay) => {
    const responses = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => relay.post(ghl(n))));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 202, 202, 202, 202]);
    assert.equal(relay.zeroSettleCalls().length, 2);
  }));

test("without GHL_API_KEY the waitlist still works, just without tags", () =>
  withWaitlist({ bindings: { GHL_API_KEY: "" } }, async (relay) => {
    await optIn(relay, 1, 2, 3);
    await relay.tick(day(1));
    assert.deepEqual(relay.sentTo(), [phone(1), phone(2), phone(3)]);
    assert.deepEqual(relay.tagCalls(), []);
  }));

test("GoHighLevel tag calls use the v2 API with the token and version header", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1);
    const call = relay.calls.find((c) => c.url.startsWith("https://services.leadconnectorhq.com/"));
    assert.equal(call.url, "https://services.leadconnectorhq.com/contacts/contact1/tags");
    assert.equal(call.headers.authorization, "Bearer ghl_test_key");
    assert.equal(call.headers.version, "2021-07-28");
    assert.deepEqual(call.body, { tags: ["jean-imessage-sent"] });
  }));

test("the secret is still required in waitlist mode, including for /booked", () =>
  withWaitlist({}, async (relay) => {
    assert.equal((await relay.post(ghl(1), { headers: {} })).status, 401);
    assert.equal((await relay.post(ghl(1), { path: "/booked", headers: { "x-relay-secret": "nope" } })).status, 401);
    assert.equal(relay.calls.length, 0);
  }));
