import { Miniflare } from "miniflare";
import { periodKey } from "../src/period.js";

export const SECRET = "s3cret-value";
export const HOUR = 60 * 60 * 1000;

/**
 * A moment on the k-th sending day after today (k = 1 is the next noon-New-York
 * reset), `hours` after that reset. Anchoring to real resets keeps the tests
 * independent of the time of day they run at.
 */
export function day(k, hours = 0) {
  let current = periodKey(Date.now(), "America/New_York", 12);
  let t = Math.ceil(Date.now() / HOUR) * HOUR;
  for (let seen = 0; ; t += HOUR) {
    const key = periodKey(t, "America/New_York", 12);
    if (key !== current && ++seen === k) return t + 60_000 + hours * HOUR;
    current = key;
  }
}

/**
 * Run the worker in the real Workers runtime (workerd via Miniflare).
 * Every outgoing request (ZeroSettle, GoHighLevel) is recorded in `calls`
 * and answered by `zeroSettle(body)` / a 200 for GoHighLevel.
 */
export async function startRelay({ waitlist = false, bindings = {}, zeroSettle } = {}) {
  const calls = [];
  const logs = [];
  const state = {
    zeroSettle:
      zeroSettle ??
      (() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
  };

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
        DAILY_LIMIT: "2",
        RESET_TIMEZONE: "America/New_York",
        RESET_HOUR: "12",
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
      if (call.url.startsWith("https://portal.zerosettle.io/")) return state.zeroSettle(call.body);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
    handleRuntimeStdio(stdout) {
      stdout.on("data", (chunk) => logs.push(String(chunk)));
    },
  });

  const relay = {
    calls,
    logs,
    /** Swap ZeroSettle's mock answer mid-test. */
    setZeroSettle(fn) {
      state.zeroSettle = fn;
    },
    zeroSettleCalls: () => calls.filter((c) => c.url.startsWith("https://portal.zerosettle.io/")),
    sentTo: () => relay.zeroSettleCalls().map((c) => c.body.to),
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
    async tick(time) {
      const worker = await mf.getWorker();
      return worker.scheduled({ scheduledTime: new Date(time), cron: "0 * * * *" });
    },
    dispose: () => mf.dispose(),
  };
  return relay;
}

/** GoHighLevel standard Webhook payload (trimmed). */
export function ghl(n, customData = {}) {
  return {
    contact_id: `contact${n}`,
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
