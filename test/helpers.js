import { Miniflare } from "miniflare";
import { localHour } from "../src/time.js";

export const SECRET = "s3cret-value";
export const HOUR = 60 * 60 * 1000;

/** `hour`:01 New York time, `daysFromToday` days from today (New York date). */
export function nyTime(daysFromToday, hour) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  for (const utcOffset of [5, 4]) {
    const t = Date.UTC(y, m - 1, d + daysFromToday, hour + utcOffset, 1);
    if (localHour(t, "America/New_York") === hour) return t;
  }
  throw new Error(`no ${hour}:01 in New York on that day`);
}

/**
 * Run the worker in the real Workers runtime (workerd via Miniflare).
 * Every outgoing request (ZeroSettle, GoHighLevel) is recorded in `calls`.
 *
 * ZeroSettle is simulated like the real API: each new contact uses one of the
 * line's `newContactLimit` daily slots, and past it a send to a new contact is
 * refused with 429 new_contact_limit (nothing sent). People already messaged
 * don't count. `newZeroSettleDay()` is the 3 AM Eastern reset.
 */
export async function startRelay({ waitlist = false, bindings = {}, zeroSettle, newContactLimit } = {}) {
  const calls = [];
  const logs = [];
  const line = { limit: newContactLimit ?? (waitlist ? 2 : Infinity), used: 0, known: new Set() };
  const simulatedZeroSettle = (body) => {
    const key = body.to.replace(/\D/g, "");
    if (!line.known.has(key)) {
      if (line.used >= line.limit) {
        return json(429, {
          error: { code: "new_contact_limit", message: "Pro includes 5 new contacts a day per number.", retry_after_s: 3600 },
        });
      }
      line.used += 1;
      line.known.add(key);
    }
    return json(200, { ok: true, status: "message_sent", record: { handle: body.to, line_id: body.line_id ?? null } });
  };
  // GET /api/imessage/messages?handle=…: outbound history on the line.
  const simulatedHistory = (url) => {
    const key = new URL(url).searchParams.get("handle").replace(/\D/g, "");
    const messages = line.known.has(key) ? [{ id: 1, direction: "out", handle: `+${key}`, status: "sent" }] : [];
    return json(200, { messages, next_after_id: messages.length });
  };
  const state = { zeroSettle: zeroSettle ?? simulatedZeroSettle, history: simulatedHistory };

  const mf = new Miniflare({
    modules: true,
    scriptPath: "src/index.js",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-30",
    ...(waitlist && { durableObjects: { LEAD_QUEUE: { className: "LeadQueue", useSQLite: true } } }),
    bindings: {
      RELAY_SECRET: SECRET,
      ZEROSETTLE_API_KEY: "zs_test_key",
      ...(waitlist && {
        GHL_API_KEY: "ghl_test_key",
        ZEROSETTLE_LINE_ID: "ln_test",
        CREATOR_TAG: "jean",
        TIMEZONE: "America/New_York",
        // No morning hold by default, so tests don't depend on the time they run at.
        HOLD_FROM_HOUR: "0",
        SEND_HOUR: "0",
        TAG_PREFIX: "jean-imessage-",
      }),
      ...bindings,
    },
    outboundService: async (request) => {
      const body = await request.text();
      const call = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: body ? JSON.parse(body) : undefined,
      };
      calls.push(call);
      if (!call.url.startsWith("https://portal.zerosettle.io/")) {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const response =
        call.method === "GET" ? await state.history(call.url) : await state.zeroSettle(call.body);
      call.status = response.status;
      return response;
    },
    handleRuntimeStdio(stdout) {
      stdout.on("data", (chunk) => logs.push(String(chunk)));
    },
  });

  const relay = {
    calls,
    logs,
    /** Swap ZeroSettle's answer mid-test; null goes back to the simulated API. */
    setZeroSettle(fn) {
      state.zeroSettle = fn ?? simulatedZeroSettle;
    },
    /** ZeroSettle's 3 AM Eastern reset of the new-contact count. */
    newZeroSettleDay() {
      line.used = 0;
    },
    setNewContactLimit(n) {
      line.limit = n;
    },
    /** Someone this line already texted before (by hand, or before the waitlist). */
    alreadyTexted(phoneNumber) {
      line.known.add(phoneNumber.replace(/\D/g, ""));
    },
    /** Swap ZeroSettle's history answer; null goes back to the simulated API. */
    setHistory(fn) {
      state.history = fn ?? simulatedHistory;
    },
    historyCalls: () => calls.filter((c) => c.method === "GET" && c.url.includes("/api/imessage/messages")),
    /** Send attempts only (not history lookups). */
    zeroSettleCalls: () => calls.filter((c) => c.method === "POST" && c.url.startsWith("https://portal.zerosettle.io/")),
    /** Everyone ZeroSettle was asked to message, accepted or not. */
    triedTo: () => relay.zeroSettleCalls().map((c) => c.body.to),
    /** Everyone ZeroSettle actually messaged. */
    sentTo: () =>
      relay
        .zeroSettleCalls()
        .filter((c) => c.status < 300)
        .map((c) => c.body.to),
    tagCalls: () =>
      calls
        .filter((c) => c.url.startsWith("https://services.leadconnectorhq.com/"))
        .map((c) => `${c.method} ${c.url.split("/contacts/")[1].split("/")[0]} ${c.body.tags.join(",")}`),
    clearCalls: () => calls.splice(0),
    post(body, { path = "/", headers = { "x-relay-secret": SECRET } } = {}) {
      return mf.dispatchFetch(`https://relay.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    fetch: (url, init) => mf.dispatchFetch(url, init),
    /** Fire the hourly cron as if it were `time` (ms since epoch). */
    async tick(time = Date.now()) {
      const worker = await mf.getWorker();
      return worker.scheduled({ scheduledTime: new Date(time), cron: "0 * * * *" });
    },
    dispose: () => mf.dispose(),
  };
  return relay;
}

/** GoHighLevel standard Webhook payload (trimmed). */
export function ghl(n, customData = {}, tags = "jean-optin") {
  return {
    contact_id: `contact${n}`,
    tags,
    first_name: `Lead${n}`,
    full_name: `Lead${n} Test`,
    phone: `+1555000000${n}`,
    workflow: { id: "wf1", name: "Jean opt-in" },
    customData: { text: `Hi Lead${n}!`, ...customData },
  };
}

export const phone = (n) => `+1555000000${n}`;

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
