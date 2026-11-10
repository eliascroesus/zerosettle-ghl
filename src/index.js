/**
 * GoHighLevel -> ZeroSettle iMessage relay.
 *
 * GoHighLevel's "Webhook" workflow action POSTs JSON with the contact's
 * standard fields at the top level (phone, first_name, contact_id, ...) plus a
 * "customData" object holding the keys set in the action. We take
 * customData.to (falling back to the top-level phone) and customData.text
 * and send them through ZeroSettle's iMessage API.
 *
 * Two modes, picked by the worker's config (wrangler.toml):
 * - Direct (no LEAD_QUEUE binding): every message is sent immediately.
 * - Waitlist (LEAD_QUEUE bound): new conversations are capped at DAILY_LIMIT
 *   per day and extra leads wait their turn; see queue.js. POST to /booked
 *   when a lead books a call to move them to the front.
 *
 * Secrets (set with `wrangler secret put` or in the Cloudflare dashboard):
 *   RELAY_SECRET        - callers must send it in the "x-relay-secret" header
 *   ZEROSETTLE_API_KEY  - sent to ZeroSettle as a Bearer token
 *   GHL_API_KEY         - (waitlist mode, optional) GoHighLevel token for status tags
 */

import { LeadQueue } from "./queue.js";
import { json, readLead, safeEqual, sendToZeroSettle, zeroSettleResponse } from "./lib.js";

export { LeadQueue };

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed. Use POST." }, 405);
    }

    // Fail closed: if RELAY_SECRET isn't configured, nothing gets through.
    const providedSecret = request.headers.get("x-relay-secret") ?? "";
    if (!env.RELAY_SECRET || !safeEqual(providedSecret, env.RELAY_SECRET)) {
      console.log("Rejected request: missing or wrong x-relay-secret header");
      return json({ error: "Unauthorized" }, 401);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      console.log("Rejected request: body is not valid JSON");
      return json({ error: "Request body must be JSON" }, 400);
    }
    console.log("Incoming payload:", JSON.stringify(payload));

    const lead = readLead(payload);
    const isBooking = env.LEAD_QUEUE && new URL(request.url).pathname.replace(/\/+$/, "") === "/booked";

    // A booking webhook may leave out text (the lead's waiting message is used).
    const missing = [!lead.to && "to", !isBooking && !lead.text.trim() && "text"].filter(Boolean);
    if (missing.length > 0) {
      console.log(`Rejected request: missing ${missing.join(" and ")}`);
      return json(
        { error: `Missing ${missing.join(" and ")} (expected customData.to or phone, and customData.text)` },
        400,
      );
    }

    if (!env.ZEROSETTLE_API_KEY) {
      console.log("Relay misconfigured: ZEROSETTLE_API_KEY secret is not set");
      return json({ error: "Relay misconfigured: ZEROSETTLE_API_KEY is not set" }, 500);
    }

    if (!env.LEAD_QUEUE) {
      return zeroSettleResponse(await sendToZeroSettle(env, lead.to, lead.text));
    }

    const queue = leadQueue(env);
    const result = isBooking ? await queue.booked(lead) : await queue.optIn(lead);
    // When a message actually went to ZeroSettle (sent, or refused for good),
    // pass ZeroSettle's answer back. Otherwise report the waitlist status.
    if (result.zeroSettle && result.status !== "waiting") return zeroSettleResponse(result.zeroSettle);
    const { zeroSettle, ...status } = result;
    return json(status, result.status === "waiting" ? 202 : 200);
  },

  async scheduled(controller, env) {
    if (!env.LEAD_QUEUE) return;
    const summary = await leadQueue(env).tick(controller.scheduledTime);
    console.log(`Hourly check: sent ${summary.sent}, ${summary.waiting} still waiting`);
  },
};

function leadQueue(env) {
  return env.LEAD_QUEUE.get(env.LEAD_QUEUE.idFromName("main"));
}
