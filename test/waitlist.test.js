// Waitlist mode (the trading worker). ZeroSettle is simulated with 2 new contacts a
// day to keep the tests short (the real Pro plan is 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ghl, json, nyTime, phone, startRelay } from "./helpers.js";

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

/** A booking webhook as the trading setup sends it: just the contact, no text. */
function booking(n) {
  const body = ghl(n);
  delete body.customData.text;
  return body;
}

const zsError = (status, code) => () => json(status, { error: { code, message: code } });

test("sends from the configured line right away, and waitlists leads once ZeroSettle says the line is full", () =>
  withWaitlist({}, async (relay) => {
    const [r1, r2, r3, r4] = await optIn(relay, 1, 2, 3, 4);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal((await r1.json()).status, "message_sent"); // ZeroSettle's own answer
    assert.equal(r3.status, 202);
    assert.deepEqual(await r3.json(), { status: "waiting", position: 1, waiting: 1 });
    // Newest first: lead 4 goes ahead of lead 3.
    assert.deepEqual(await r4.json(), { status: "waiting", position: 1, waiting: 2 });

    assert.deepEqual(relay.sentTo(), [phone(1), phone(2)]);
    assert.ok(relay.zeroSettleCalls().every((c) => c.body.line_id === "ln_test"));
    assert.deepEqual(relay.tagCalls(), [
      "POST contact1 jean-imessage-sent",
      "DELETE contact1 jean-imessage-waiting,jean-imessage-priority",
      "POST contact2 jean-imessage-sent",
      "DELETE contact2 jean-imessage-waiting,jean-imessage-priority",
      "POST contact3 jean-imessage-waiting",
      "POST contact4 jean-imessage-waiting",
    ]);
  }));

test("after ZeroSettle's daily reset, the waitlist goes out newest first and the rest keep waiting", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4, 5, 6);
    relay.clearCalls();

    // Hourly checks while the line is still full send nothing.
    await relay.tick();
    assert.deepEqual(relay.sentTo(), []);

    relay.newZeroSettleDay();
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(6), phone(5)]);

    // New opt-ins that day wait too (the waitlist used the day's slots).
    assert.equal((await relay.post(ghl(7))).status, 202);

    relay.newZeroSettleDay();
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(6), phone(5), phone(7), phone(4)]);
  }));

test("between 3 AM and noon opt-ins wait for the noon batch, but booked leads go right away", () =>
  withWaitlist({ bindings: { HOLD_FROM_HOUR: "3", SEND_HOUR: "12" }, newContactLimit: 0 }, async (relay) => {
    // Line full: everyone waits, whatever time the test runs at.
    await optIn(relay, 1, 2, 3);
    await relay.post(booking(2), { path: "/booked" });
    relay.clearCalls();

    relay.setNewContactLimit(2);
    relay.newZeroSettleDay();

    await relay.tick(nyTime(1, 10)); // 10 AM: only the booked lead
    assert.deepEqual(relay.triedTo(), [phone(2)]);

    await relay.tick(nyTime(1, 12)); // noon batch: newest first, until the line is full
    assert.deepEqual(relay.sentTo(), [phone(2), phone(3)]);
    assert.deepEqual(relay.triedTo(), [phone(2), phone(3), phone(1)]);
  }));

test("a lead who books a call jumps to the front of the waitlist", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4, 5);
    relay.clearCalls();

    // Lead 3 (in the middle of the waitlist) books a call; the booking webhook has no text.
    const res = await relay.post(booking(3), { path: "/booked" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: "waiting", position: 1, waiting: 3 });
    assert.deepEqual(relay.tagCalls(), ["POST contact3 jean-imessage-waiting,jean-imessage-priority"]);

    relay.newZeroSettleDay();
    await relay.tick();
    // Booked lead first (with their original message), then the newest opt-in.
    assert.deepEqual(
      relay
        .zeroSettleCalls()
        .filter((c) => c.status === 200)
        .map((c) => ({ to: c.body.to, text: c.body.text })),
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
    relay.newZeroSettleDay();
    await relay.tick();
    assert.equal(relay.zeroSettleCalls()[0].body.text, "Saw you booked a call!");
  }));

test("a booked lead who never opted in is sent now if there's room, otherwise waits at the front", () =>
  withWaitlist({}, async (relay) => {
    const first = await relay.post(ghl(1, { text: "Booking msg" }), { path: "/booked" });
    assert.equal(first.status, 200);
    assert.deepEqual(relay.sentTo(), [phone(1)]);

    await optIn(relay, 2, 3); // 2 takes the last slot, 3 waits
    const booked = await relay.post(ghl(4, { text: "Booking msg" }), { path: "/booked" });
    assert.equal(booked.status, 202);
    assert.equal((await booked.json()).position, 1);
  }));

test("booking during the opt-in workflow's wait step puts them first once their message comes in", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3); // line full, 3 waiting

    // Lead 4 books before their opt-in webhook (still in the 3-minute wait) fires.
    const booked = await relay.post(booking(4), { path: "/booked" });
    assert.equal(booked.status, 200);
    assert.equal((await booked.json()).status, "booked");
    relay.clearCalls();

    // Their opt-in webhook arrives: they go to the front, tagged as priority.
    const res = await relay.post(ghl(4));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: "waiting", position: 1, waiting: 2 });
    assert.deepEqual(relay.tagCalls(), ["POST contact4 jean-imessage-waiting,jean-imessage-priority"]);

    // A newer, non-booked opt-in still goes behind them.
    assert.equal((await (await relay.post(ghl(5))).json()).position, 2);

    relay.newZeroSettleDay();
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(4), phone(5)]);
  }));

test("booking during the wait step with room on the line sends their one message as normal", () =>
  withWaitlist({}, async (relay) => {
    await relay.post(booking(1), { path: "/booked" });
    assert.equal(relay.calls.length, 0);
    const res = await relay.post(ghl(1));
    assert.equal(res.status, 200);
    assert.deepEqual(relay.sentTo(), [phone(1)]);
    // Booking again later changes nothing.
    assert.deepEqual(await (await relay.post(booking(1), { path: "/booked" })).json(), { status: "already_sent" });
    assert.equal(relay.zeroSettleCalls().length, 1);
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

test("follow-ups to someone already messaged go straight through, even when the line is full", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2); // line full
    const followUp = await relay.post(ghl(1, { text: "Following up!" }));
    assert.equal(followUp.status, 200);
    assert.deepEqual(relay.zeroSettleCalls().at(-1).body, { to: phone(1), text: "Following up!", line_id: "ln_test" });
    // Still no room for a brand-new lead.
    assert.equal((await relay.post(ghl(3))).status, 202);
  }));

test("phone numbers in different formats count as the same person", () =>
  withWaitlist({}, async (relay) => {
    await relay.post(ghl(1, { to: "+1 (555) 000-0001" }));
    await relay.post(ghl(2, { to: "+15550000001", text: "Again" }));
    assert.equal(relay.zeroSettleCalls().length, 2); // the second one is a follow-up
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

    relay.newZeroSettleDay();
    await relay.tick();
    assert.equal(relay.zeroSettleCalls()[0].body.text, "Hi Lead3!");
  }));

test("ZeroSettle's daily message limit also keeps everyone's place", () =>
  withWaitlist({}, async (relay) => {
    relay.setZeroSettle(zsError(429, "daily_limit"));
    const res = await relay.post(ghl(1));
    assert.equal(res.status, 202);
    relay.setZeroSettle(null);
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(1)]);
  }));

test("leads ZeroSettle can't message (bad number, opted out) are marked failed and the next lead goes", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3, 4, 5);
    relay.clearCalls();
    relay.newZeroSettleDay();
    relay.setZeroSettle((body) =>
      body.to === phone(5)
        ? json(422, { error: { code: "invalid_request" } })
        : body.to === phone(4)
          ? json(403, { error: { code: "recipient_opted_out" } })
          : json(200, { ok: true }),
    );
    await relay.tick();
    assert.deepEqual(relay.triedTo(), [phone(5), phone(4), phone(3)]);
    assert.deepEqual(relay.sentTo(), [phone(3)]);
    assert.ok(relay.tagCalls().includes("POST contact5 jean-imessage-failed"));
    assert.ok(relay.tagCalls().includes("POST contact4 jean-imessage-failed"));
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-sent"));
  }));

test("a temporary ZeroSettle outage keeps everyone waiting and retries hourly", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.newZeroSettleDay();
    relay.setZeroSettle(zsError(503, "phone_offline"));
    for (let h = 0; h < 4; h++) await relay.tick();
    assert.deepEqual(relay.triedTo(), [phone(3), phone(3), phone(3), phone(3)]); // one try per hour

    relay.setZeroSettle(null);
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(3)]);
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-sent"));
  }));

test("a lead whose sends keep failing temporarily is marked failed after 5 tries", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.setZeroSettle(zsError(503, "phone_offline"));
    for (let h = 0; h < 5; h++) await relay.tick();
    assert.ok(relay.tagCalls().includes("POST contact3 jean-imessage-failed"));
  }));

test("setup problems (bad API key, wrong line id) never cost anyone their place", () =>
  withWaitlist({}, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.clearCalls();
    relay.newZeroSettleDay();
    for (const answer of [json(401, { error: "bad key" }), json(404, { error: { code: "unknown_line" } })]) {
      relay.setZeroSettle(() => answer.clone());
      for (let h = 0; h < 6; h++) await relay.tick();
    }
    assert.ok(!relay.tagCalls().some((t) => t.includes("failed")));

    relay.setZeroSettle(null);
    await relay.tick();
    assert.deepEqual(relay.sentTo(), [phone(3)]);
  }));

test("many opt-ins at the same moment never get anyone sent twice", () =>
  withWaitlist({}, async (relay) => {
    const responses = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => relay.post(ghl(n))));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 202, 202, 202, 202]);
    assert.equal(relay.sentTo().length, 2);
    assert.equal(new Set(relay.sentTo()).size, 2);
  }));

test("without GHL_API_KEY the waitlist still works, just without tags", () =>
  withWaitlist({ bindings: { GHL_API_KEY: "" } }, async (relay) => {
    await optIn(relay, 1, 2, 3);
    relay.newZeroSettleDay();
    await relay.tick();
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
