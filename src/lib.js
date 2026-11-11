// Helpers shared by the direct relay (index.js) and the daily waitlist (queue.js).

export const ZEROSETTLE_SEND_URL = "https://portal.zerosettle.io/api/imessage/send";

/**
 * Pull what we need out of GoHighLevel's Webhook action payload: contact fields
 * at the top level, the action's Custom Data under "customData".
 */
export function readLead(payload) {
  const customData = payload?.customData ?? {};
  return {
    to: asString(customData.to).trim() || asString(payload?.phone).trim(),
    text: asString(customData.text),
    contactId: asString(payload?.contact_id).trim(),
    name: asString(payload?.full_name).trim() || asString(payload?.first_name).trim(),
  };
}

/** Digits only, so "+1 (555) 123-4567" and "+15551234567" count as the same person. */
export function phoneKey(to) {
  return to.replace(/\D/g, "") || to;
}

/**
 * POST one message to ZeroSettle. Never throws; a network failure comes back as status 0.
 *
 * With ZEROSETTLE_LINE_ID set, the message goes out from exactly that line. Without it,
 * ZeroSettle picks a line itself on accounts with several numbers, so one creator's leads
 * can end up on another creator's line.
 */
export async function sendToZeroSettle(env, to, text) {
  const message = { to, text };
  if (env.ZEROSETTLE_LINE_ID) message.line_id = env.ZEROSETTLE_LINE_ID;
  try {
    const res = await fetch(ZEROSETTLE_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ZEROSETTLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    console.log(`ZeroSettle response: ${res.status} ${body}`);
    return {
      ok: res.ok,
      status: res.status,
      code: errorCode(body),
      body,
      contentType: res.headers.get("Content-Type") ?? "application/json",
    };
  } catch (err) {
    console.log("Could not reach ZeroSettle:", String(err));
    return { ok: false, status: 0, code: "", body: "", contentType: "application/json" };
  }
}

/** ZeroSettle errors look like {"error": {"code": "new_contact_limit", ...}}. */
function errorCode(body) {
  try {
    return JSON.parse(body)?.error?.code ?? "";
  } catch {
    return "";
  }
}

/** Turn a ZeroSettle result into the response GoHighLevel gets back. */
export function zeroSettleResponse(result) {
  if (result.status === 0) return json({ error: "Could not reach ZeroSettle" }, 502);
  return new Response(result.body || null, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
}

export function asString(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

// Constant-time comparison so the secret can't be guessed via response timing.
export function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
