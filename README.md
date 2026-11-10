# zerosettle-ghl-relay

A Cloudflare Worker that receives GoHighLevel workflow **Webhook** actions and sends the message through ZeroSettle's iMessage API.

## How it works

1. GoHighLevel POSTs JSON to the worker. The contact's fields (`phone`, `first_name`, ...) are at the top level, and the action's **Custom Data** sits in `customData`.
2. The worker returns `401` unless the request has an `x-relay-secret` header that matches the `RELAY_SECRET` secret.
3. It reads `to` from `customData.to`, or from the top-level `phone` if that's empty, and reads `text` from `customData.text`.
4. It POSTs `{"to": ..., "text": ...}` to `https://portal.zerosettle.io/api/imessage/send` with `Authorization: Bearer $ZEROSETTLE_API_KEY`.
5. It returns ZeroSettle's status code and body to GoHighLevel, and logs both the incoming payload and ZeroSettle's response.

Responses the worker sends itself: `401` for a bad or missing secret, `400` for a body that isn't JSON or is missing `to`/`text`, `405` for a non-POST request, `500` if `ZEROSETTLE_API_KEY` isn't set, and `502` if ZeroSettle can't be reached.

## GoHighLevel setup

In the workflow, add a **Webhook** action:

- **Method:** POST
- **URL:** the worker URL, `https://zerosettle-ghl-relay.<your-subdomain>.workers.dev`
- **Custom Data:** `to` → `{{contact.phone}}` (optional; the contact's phone is the default), and `text` → your message
- **Headers:** `x-relay-secret` → the RELAY_SECRET value

## Secrets

Secrets are set on Cloudflare and never stored in this repo:

```bash
npx wrangler secret put RELAY_SECRET
npx wrangler secret put ZEROSETTLE_API_KEY
```

You can also set them in the Cloudflare dashboard: Workers & Pages → zerosettle-ghl-relay → Settings → Variables and Secrets.

## One worker per creator

Each creator gets their own worker, with its own URL, secrets (its own ZeroSettle line's API key) and logs. The workers share the same code.

| Creator | Worker | URL | Deploy |
| --- | --- | --- | --- |
| Ricky (e-com) | `zerosettle-ghl-relay` | `https://zerosettle-ghl-relay.ghl-imessage.workers.dev` | `npx wrangler deploy` |
| Trading | `zerosettle-ghl-relay-trading` | `https://zerosettle-ghl-relay-trading.ghl-imessage.workers.dev` | `npx wrangler deploy --env trading` |

To add another creator, add an `[env.<name>]` block to `wrangler.toml`, deploy it with `--env <name>`, and set both secrets with `--env <name>`.

## Daily waitlist (trading worker)

The trading line's ZeroSettle plan only allows `DAILY_LIMIT` (5) new conversations per day, so that worker adds a waitlist (`src/queue.js`, stored in a Durable Object):

- **Who uses a slot:** only the first message to a new number. Messages to someone who was already messaged go straight through. More messages for someone who is still waiting are skipped until their first one goes out.
- **Order:** people who booked a call go first, then the newest opt-ins.
- **Daily reset:** a new sending day starts at `RESET_HOUR` (12, noon) in `RESET_TIMEZONE` (America/New_York). An hourly cron sends the waitlist first, until the day's slots are used up. Any slots left over go to new opt-ins as they arrive.
- **Booked calls:** a GoHighLevel workflow (trigger: tag `jean-booked` added, or Appointment Booked) sends a Webhook to `/booked` with the same header. If that lead is still waiting, they move to the front. If the webhook has `text`, it replaces their waiting message.
- **ZeroSettle refusals:**
  - Limit reached (429, or a body mentioning a limit): the lead keeps their place until the next day.
  - Rejected API key (401/403): the lead keeps their place and the worker retries hourly.
  - Bad number (400/404/422): the lead is marked failed.
  - Temporary errors: the worker retries hourly and marks the lead failed after 5 tries.
- **GoHighLevel tags:** with a `GHL_API_KEY` secret (a Private Integration token from the sub-account with the contacts write scope), each contact gets tagged `TAG_PREFIX` + `waiting`, `priority`, `sent` or `failed`. Without it, everything still works, just without tags.

Responses to GoHighLevel:
- When a message was sent (or refused for good), the worker returns ZeroSettle's own response.
- When a lead is waitlisted, it returns `202 {"status":"waiting","position":N,"waiting":M}`.
- `/booked` can also return `200` with `already_sent` or `ignored`.

Tests run the worker in the real Workers runtime through Miniflare (`npm test`).

## Commands

```bash
npm install
npm test         # unit tests (no network)
npm run deploy   # wrangler deploy
npm run logs     # live logs (wrangler tail)
```

Logs are kept in the dashboard as well: Workers & Pages → zerosettle-ghl-relay → **Logs**.
