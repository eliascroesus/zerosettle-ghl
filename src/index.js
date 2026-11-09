/**
 * GoHighLevel -> ZeroSettle iMessage relay.
 *
 * GoHighLevel's "Webhook" workflow action POSTs JSON with the contact's
 * standard fields at the top level (phone, first_name, ...) plus a
 * "customData" object holding the keys set in the action. We take
 * customData.to (falling back to the top-level phone) and customData.text
 * and forward them to ZeroSettle's iMessage send API.
 *
 * Secrets (set with `wrangler secret put` or in the Cloudflare dashboard):
 *   RELAY_SECRET        - callers must send it in the "x-relay-secret" header
 *   ZEROSETTLE_API_KEY  - sent to ZeroSettle as a Bearer token
 */

const ZEROSETTLE_SEND_URL = "https://portal.zerosettle.io/api/imessage/send";

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

    const customData = payload?.customData ?? {};
    const to = asString(customData.to).trim() || asString(payload?.phone).trim();
    const text = asString(customData.text);

    if (!to || !text.trim()) {
      const missing = [!to && "to", !text.trim() && "text"].filter(Boolean);
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

    let upstream;
    try {
      upstream = await fetch(ZEROSETTLE_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ZEROSETTLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to, text }),
      });
    } catch (err) {
      console.log("Could not reach ZeroSettle:", String(err));
      return json({ error: "Could not reach ZeroSettle" }, 502);
    }

    const upstreamBody = await upstream.text();
    console.log(`ZeroSettle response: ${upstream.status} ${upstreamBody}`);

    return new Response(upstreamBody || null, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  },
};

function asString(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

// Constant-time comparison so the secret can't be guessed via response timing.
function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
