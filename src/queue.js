import { DurableObject } from "cloudflare:workers";
import { updateTags } from "./ghl.js";
import { phoneKey, sendToZeroSettle } from "./lib.js";
import { localHour } from "./time.js";

/**
 * Waitlist for a ZeroSettle line that can only start a few new conversations a
 * day (5 per number on the Pro plan, reset at 3 AM Eastern). ZeroSettle enforces
 * that limit itself: a send to a new contact on a full line is refused with
 * 429 new_contact_limit and nothing is sent. The waitlist makes sure nobody is
 * lost when that happens, and decides who gets the slots:
 *
 * - The first message to a new number needs a slot. If ZeroSettle says the line
 *   is full, the lead waits. Messages to someone already messaged go straight
 *   through (ongoing conversations don't count toward the limit).
 * - Order: people who booked a call first, then newest opt-ins first.
 * - From HOLD_FROM_HOUR (3, when ZeroSettle's day resets) until SEND_HOUR (12),
 *   in TIMEZONE, opt-ins wait so the new day's slots go out as one batch at
 *   SEND_HOUR in waitlist order. People who booked a call don't wait for it.
 * - An hourly cron tick sends whoever fits; it is what sends the SEND_HOUR batch.
 * - Each lead's status is mirrored to GoHighLevel tags (see ghl.js).
 *
 * One instance holds all state in SQLite, and every operation runs one at a
 * time (see #serialize), so two webhooks never race for the same lead.
 */
export class LeadQueue extends DurableObject {
  #lock = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        phone_key   TEXT PRIMARY KEY,
        to_number   TEXT NOT NULL,
        contact_id  TEXT,
        name        TEXT,
        text        TEXT,
        status      TEXT NOT NULL,             -- waiting | sent | failed | booked (booked, message not in yet)
        priority    INTEGER NOT NULL DEFAULT 0, -- 1 = booked a call
        opted_in_at INTEGER NOT NULL,
        sent_at     INTEGER,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT
      );
      CREATE INDEX IF NOT EXISTS leads_by_queue_order
        ON leads (status, priority DESC, opted_in_at DESC);
    `);
  }

  /** A lead opted in (or a workflow sent another message to someone). */
  optIn(lead) {
    return this.#serialize(() => this.#optIn(lead, Date.now()));
  }

  /** A lead booked a call: if they're still waiting, they jump the line. */
  booked(lead) {
    return this.#serialize(() => this.#booked(lead, Date.now()));
  }

  /** Hourly cron: send whoever fits now. */
  tick(now) {
    return this.#serialize(() => this.#tick(now));
  }

  // --- operations -----------------------------------------------------------

  async #optIn(lead, now) {
    const key = phoneKey(lead.to);
    const existing = this.#lead(key);

    if (existing?.status === "sent") {
      console.log(`${lead.to} was already messaged: sending this follow-up now (doesn't count as a new contact)`);
      const zeroSettle = await sendToZeroSettle(this.env, lead.to, lead.text);
      return { status: zeroSettle.ok ? "sent" : "failed", followUp: true, zeroSettle };
    }
    if (existing?.status === "waiting") {
      console.log(`${lead.to} is already on the waitlist: skipping this message until their first one is sent`);
      return { status: "waiting", note: "Already on the waitlist; this message was skipped.", ...this.#position(key) };
    }

    // Booked a call before this first message reached us (e.g. during the workflow's wait step)?
    const priority = existing?.status === "booked" ? 1 : 0;
    if (priority) console.log(`${lead.to} already booked a call: going to the front of the line`);
    this.#upsertWaiting(key, lead, { text: lead.text, priority, optedInAt: now });
    const drained = await this.#drain(now);
    return this.#outcomeFor(key, lead, drained);
  }

  async #booked(lead, now) {
    const key = phoneKey(lead.to);
    const existing = this.#lead(key);

    if (existing?.status === "sent") {
      console.log(`${lead.to} booked a call and was already messaged: nothing to do`);
      return { status: "already_sent" };
    }
    const text = lead.text.trim() ? lead.text : existing?.text;
    if (!text?.trim()) {
      // Their first message hasn't reached us yet (e.g. the opt-in workflow is still in its
      // wait step). Remember the booking so they go to the front when it arrives.
      this.sql.exec(
        `INSERT INTO leads (phone_key, to_number, contact_id, name, status, priority, opted_in_at)
         VALUES (?, ?, ?, ?, 'booked', 1, ?)
         ON CONFLICT (phone_key) DO UPDATE SET priority = 1`,
        key,
        lead.to,
        lead.contactId,
        lead.name,
        now,
      );
      console.log(`${lead.to} booked a call before their first message came in: they'll go first when it does`);
      return { status: "booked", note: "Not messaged yet; they go to the front of the line when their message comes in." };
    }

    console.log(`${lead.to} booked a call: moving to the front of the waitlist`);
    this.#upsertWaiting(key, lead, { text, priority: 1, optedInAt: existing?.opted_in_at ?? now });
    const drained = await this.#drain(now);
    return this.#outcomeFor(key, lead, drained);
  }

  async #tick(now) {
    if (this.#waitingCount() === 0) return { sent: 0, waiting: 0 };
    const { results } = await this.#drain(now);
    const sent = [...results.values()].filter((r) => r.status === "sent").length;
    return { sent, waiting: this.#waitingCount() };
  }

  /**
   * Send to waiting leads in queue order until ZeroSettle says the line is full,
   * or nobody sendable is left. During the morning hold only booked leads go.
   * Returns { results: Map(phone_key -> { status, zeroSettle }), held, stopped }.
   */
  async #drain(now) {
    const results = new Map();
    const held = this.#inHold(now);
    let stopped = null;

    while (true) {
      const lead = this.sql
        .exec(
          `SELECT * FROM leads WHERE status = 'waiting' ${held ? "AND priority > 0" : ""}
           ORDER BY priority DESC, opted_in_at DESC LIMIT 1`,
        )
        .toArray()[0];
      if (!lead) break;

      const zeroSettle = await sendToZeroSettle(this.env, lead.to_number, lead.text);
      const outcome = classify(zeroSettle);

      if (outcome === "sent") {
        this.sql.exec(
          `UPDATE leads SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL
           WHERE phone_key = ?`,
          Date.now(),
          lead.phone_key,
        );
        console.log(`Sent first message to ${lead.to_number}${lead.priority ? " (booked a call)" : ""}`);
        await updateTags(this.env, lead.contact_id, { add: ["sent"], remove: ["waiting", "priority"] });
        results.set(lead.phone_key, { status: "sent", zeroSettle });
        continue;
      }

      const error = `${zeroSettle.status} ${zeroSettle.body}`.slice(0, 500);

      if (outcome === "limit" || outcome === "config") {
        // The line can't take a new contact right now; not this lead's fault, so nobody
        // loses their place. A full line frees up at ZeroSettle's 3 AM Eastern reset.
        this.sql.exec(`UPDATE leads SET last_error = ? WHERE phone_key = ?`, error, lead.phone_key);
        console.log(
          outcome === "limit"
            ? `Line is out of new contacts for today (${zeroSettle.code || zeroSettle.status}): the waitlist goes out after ZeroSettle's 3 AM Eastern reset`
            : `ZeroSettle refused the send for a setup reason (${zeroSettle.code || zeroSettle.status}): check ZEROSETTLE_API_KEY / ZEROSETTLE_LINE_ID. Retrying next hour.`,
        );
        results.set(lead.phone_key, { status: "waiting", zeroSettle });
        stopped = outcome;
        break;
      }

      const attempts = lead.attempts + 1;
      if (outcome === "failed" || attempts >= MAX_ATTEMPTS) {
        this.sql.exec(
          `UPDATE leads SET status = 'failed', attempts = ?, last_error = ? WHERE phone_key = ?`,
          attempts,
          error,
          lead.phone_key,
        );
        console.log(`Could not message ${lead.to_number} (${error}): marked failed, moving on`);
        await updateTags(this.env, lead.contact_id, { add: ["failed"], remove: ["waiting", "priority"] });
        results.set(lead.phone_key, { status: "failed", zeroSettle });
        continue;
      }

      // Temporary problem (ZeroSettle or the phone briefly unavailable): keep their place.
      this.sql.exec(
        `UPDATE leads SET attempts = ?, last_error = ? WHERE phone_key = ?`,
        attempts,
        error,
        lead.phone_key,
      );
      console.log(`Temporary ZeroSettle problem (${error}): ${lead.to_number} keeps their place, retrying next hour`);
      results.set(lead.phone_key, { status: "waiting", zeroSettle });
      stopped = "retry";
      break;
    }
    return { results, held, stopped };
  }

  /** What to tell GoHighLevel about this webhook's lead after a drain. */
  async #outcomeFor(key, lead, { results, held, stopped }) {
    const result = results.get(key);
    if (result && result.status !== "waiting") return result;

    const row = this.#lead(key);
    await updateTags(this.env, row.contact_id, {
      add: row.priority ? ["waiting", "priority"] : ["waiting"],
    });
    const position = this.#position(key);
    const why =
      stopped === "limit"
        ? "the line is out of new contacts for today"
        : held && !row.priority
          ? `waiting for the ${this.env.SEND_HOUR ?? 12}:00 batch`
          : "waiting for the next try";
    console.log(`${lead.to} is on the waitlist: #${position.position} of ${position.waiting} (${why})`);
    return { status: "waiting", ...position };
  }

  // --- state helpers --------------------------------------------------------

  #upsertWaiting(key, lead, { text, priority, optedInAt }) {
    this.sql.exec(
      `INSERT INTO leads (phone_key, to_number, contact_id, name, text, status, priority, opted_in_at, attempts)
       VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, 0)
       ON CONFLICT (phone_key) DO UPDATE SET
         to_number  = excluded.to_number,
         contact_id = COALESCE(NULLIF(excluded.contact_id, ''), leads.contact_id),
         name       = COALESCE(NULLIF(excluded.name, ''), leads.name),
         text       = excluded.text,
         status     = 'waiting',
         priority   = excluded.priority,
         opted_in_at = excluded.opted_in_at,
         attempts   = 0,
         last_error = NULL`,
      key,
      lead.to,
      lead.contactId,
      lead.name,
      text,
      priority,
      optedInAt,
    );
  }

  /** True between HOLD_FROM_HOUR and SEND_HOUR (local time): opt-ins wait for the batch. */
  #inHold(now) {
    const from = Number(this.env.HOLD_FROM_HOUR ?? 3);
    const until = Number(this.env.SEND_HOUR ?? 12);
    const hour = localHour(now, this.env.TIMEZONE ?? "America/New_York");
    return from <= until ? from <= hour && hour < until : hour >= from || hour < until;
  }

  #position(key) {
    const me = this.#lead(key);
    const ahead = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM leads WHERE status = 'waiting'
         AND (priority > ? OR (priority = ? AND opted_in_at > ?))`,
        me.priority,
        me.priority,
        me.opted_in_at,
      )
      .one().n;
    return { position: ahead + 1, waiting: this.#waitingCount() };
  }

  #lead(key) {
    return this.sql.exec(`SELECT * FROM leads WHERE phone_key = ?`, key).toArray()[0];
  }

  #waitingCount() {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM leads WHERE status = 'waiting'`).one().n;
  }

  /** Run operations strictly one after another, even across awaits on fetch(). */
  #serialize(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(() => {});
    return run;
  }
}

// A lead whose sends keep failing temporarily is marked failed after this many tries
// (about this many hours), so one bad number can't block the whole waitlist.
const MAX_ATTEMPTS = 5;

// ZeroSettle error codes (portal.zerosettle.io/docs.md, "Errors").
const LINE_FULL = new Set(["new_contact_limit", "daily_limit"]);
const SETUP_PROBLEM = new Set(["unauthorized", "payment_required", "forbidden", "unknown_line", "line_draining", "managed_by_zerosettle"]);
const TEMPORARY = new Set(["line_busy", "phone_offline", "phone_timeout", "unavailable", "rate_limited"]);

/**
 * sent | limit (line full today) | config (our setup; retry hourly) |
 * failed (this lead can't be messaged: opted out, bad number...) | retry (temporary)
 */
function classify({ ok, status, code }) {
  if (ok) return "sent";
  if (LINE_FULL.has(code)) return "limit";
  if (SETUP_PROBLEM.has(code)) return "config";
  if (TEMPORARY.has(code)) return "retry";
  if (code === "send_failed") return "failed";
  if (status === 429) return "limit";
  if (status === 401 || status === 402) return "config";
  if (status >= 400 && status < 500) return "failed";
  return "retry";
}
