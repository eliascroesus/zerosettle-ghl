import { DurableObject } from "cloudflare:workers";
import { updateTags } from "./ghl.js";
import { periodKey } from "./period.js";
import { phoneKey, sendToZeroSettle } from "./lib.js";

/**
 * Daily waitlist for a ZeroSettle line that can only start a few new
 * conversations per day (DAILY_LIMIT).
 *
 * - The first message to a new number uses one of the day's slots. If none is
 *   left, the lead waits. Messages to a number that was already messaged go
 *   straight through and don't use a slot.
 * - Waiting order: people who booked a call first, then newest opt-ins first.
 * - Every hour a cron tick calls tick(). At RESET_HOUR (RESET_TIMEZONE) a new
 *   sending day starts, the counter goes back to 0 and the waitlist is sent first.
 * - If ZeroSettle refuses a send (e.g. its own limit), the lead keeps its place.
 * - Each lead's status is mirrored to GoHighLevel tags (see ghl.js).
 *
 * One instance holds all state in SQLite, and every operation runs one at a
 * time (see #serialize) so two webhooks can never both take the last slot.
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
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

  /** Hourly cron: start a new sending day when it's time, then send whoever fits. */
  tick(now) {
    return this.#serialize(() => this.#tick(now));
  }

  // --- operations -----------------------------------------------------------

  async #optIn(lead, now) {
    this.#rollPeriod(now);
    const key = phoneKey(lead.to);
    const existing = this.#lead(key);

    if (existing?.status === "sent") {
      console.log(`${lead.to} was already messaged: sending this follow-up now (no daily slot used)`);
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
    const results = await this.#drain();
    return this.#outcomeFor(key, lead, results);
  }

  async #booked(lead, now) {
    this.#rollPeriod(now);
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
    const results = await this.#drain();
    return this.#outcomeFor(key, lead, results);
  }

  async #tick(now) {
    const newDay = this.#rollPeriod(now);
    const waiting = this.#waitingCount();
    if (newDay) {
      console.log(`New sending day ${this.#meta("period")}: ${this.#limit()} slots, ${waiting} on the waitlist`);
    }
    if (waiting === 0) return { sent: 0, waiting: 0 };
    const results = await this.#drain();
    const sent = [...results.values()].filter((r) => r.status === "sent").length;
    return { sent, waiting: this.#waitingCount() };
  }

  /**
   * Send to waiting leads in priority order while today's slots last.
   * Returns a Map of phone_key -> { status, zeroSettle } for every lead tried.
   */
  async #drain() {
    const results = new Map();
    const limit = this.#limit();
    let used = this.#used();

    while (used < limit) {
      const lead = this.sql
        .exec(
          `SELECT * FROM leads WHERE status = 'waiting'
           ORDER BY priority DESC, opted_in_at DESC LIMIT 1`,
        )
        .toArray()[0];
      if (!lead) break;

      const zeroSettle = await sendToZeroSettle(this.env, lead.to_number, lead.text);
      const outcome = classify(zeroSettle);

      if (outcome === "sent") {
        used += 1;
        this.#setMeta("used", used);
        this.sql.exec(
          `UPDATE leads SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL
           WHERE phone_key = ?`,
          Date.now(),
          lead.phone_key,
        );
        console.log(`Sent first message to ${lead.to_number}${lead.priority ? " (booked a call)" : ""}: ${used}/${limit} slots used`);
        await updateTags(this.env, lead.contact_id, { add: ["sent"], remove: ["waiting", "priority"] });
        results.set(lead.phone_key, { status: "sent", zeroSettle });
        continue;
      }

      const error = `${zeroSettle.status} ${zeroSettle.body}`.slice(0, 500);

      if (outcome === "limit") {
        // ZeroSettle says the line is out of new conversations: wait for the next day.
        this.#setMeta("used", limit);
        this.sql.exec(`UPDATE leads SET last_error = ? WHERE phone_key = ?`, error, lead.phone_key);
        console.log(`ZeroSettle daily limit reached: ${lead.to_number} keeps their place for the next reset`);
        results.set(lead.phone_key, { status: "waiting", zeroSettle });
        break;
      }

      if (outcome === "config") {
        // Our ZeroSettle key was refused. Not the lead's fault; nobody loses their place.
        this.sql.exec(`UPDATE leads SET last_error = ? WHERE phone_key = ?`, error, lead.phone_key);
        console.log(`ZeroSettle refused the API key (${zeroSettle.status}): check ZEROSETTLE_API_KEY. Will retry next hour.`);
        results.set(lead.phone_key, { status: "waiting", zeroSettle });
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

      // Temporary problem (ZeroSettle down, timeout): keep their place, retry next hour.
      this.sql.exec(
        `UPDATE leads SET attempts = ?, last_error = ? WHERE phone_key = ?`,
        attempts,
        error,
        lead.phone_key,
      );
      console.log(`Temporary ZeroSettle problem (${error}): ${lead.to_number} keeps their place, retrying next hour`);
      results.set(lead.phone_key, { status: "waiting", zeroSettle });
      break;
    }
    return results;
  }

  /** What to tell GoHighLevel about this webhook's lead after a drain. */
  async #outcomeFor(key, lead, results) {
    const result = results.get(key);
    if (result && result.status !== "waiting") return result;

    const row = this.#lead(key);
    await updateTags(this.env, row.contact_id, {
      add: row.priority ? ["waiting", "priority"] : ["waiting"],
    });
    const position = this.#position(key);
    console.log(
      `${lead.to} is on the waitlist: #${position.position} of ${position.waiting}` +
        ` (${this.#used()}/${this.#limit()} slots used today)`,
    );
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

  /** Start a new sending day if one has begun. Only ever moves forward. */
  #rollPeriod(now) {
    const period = periodKey(now, this.env.RESET_TIMEZONE ?? "America/New_York", Number(this.env.RESET_HOUR ?? 12));
    const current = this.#meta("period");
    if (current && period <= current) return false;
    this.#setMeta("period", period);
    this.#setMeta("used", 0);
    return true;
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

  #limit() {
    return Number(this.env.DAILY_LIMIT ?? 5);
  }

  #used() {
    return Number(this.#meta("used") ?? 0);
  }

  #meta(key) {
    return this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value;
  }

  #setMeta(key, value) {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      String(value),
    );
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

/** sent | limit | config | failed | retry */
function classify({ ok, status, body }) {
  if (ok) return "sent";
  if (status === 429 || /limit|quota|exceed|too many/i.test(body)) return "limit";
  if (status === 401 || status === 403) return "config";
  if (status === 400 || status === 404 || status === 422) return "failed";
  return "retry";
}
