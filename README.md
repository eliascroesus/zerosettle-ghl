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

| Creator | Worker | URL | ZeroSettle line | Deploy |
| --- | --- | --- | --- | --- |
| Ricky (e-com) | `zerosettle-ghl-relay` | `https://zerosettle-ghl-relay.ghl-imessage.workers.dev` | +1 (415) 595-8874, `ln_5e26a0ae50f4ea21` | `npx wrangler deploy --env=""` |
| Jean (trading) | `zerosettle-ghl-relay-trading` | `https://zerosettle-ghl-relay-trading.ghl-imessage.workers.dev` | +1 (415) 802-3056, `ln_08cecb430b9c9ae9` | `npx wrangler deploy --env trading` |

Both lines are on the same ZeroSettle account, so they share one API key. Each worker's `ZEROSETTLE_LINE_ID` var tells ZeroSettle which line to send from. Without it, ZeroSettle sends each new contact from whichever line has the most room left that day, which mixes the creators up.

To add another creator, add an `[env.<name>]` block to `wrangler.toml`, deploy it with `--env <name>`, and set both secrets with `--env <name>`.

## Daily waitlist (both workers)

ZeroSettle's Pro plan allows **5 new contacts a day per line**, reset at **3 AM Eastern**. Ongoing conversations don't count. ZeroSettle enforces this itself: a send to a new contact on a full line is refused with `429 new_contact_limit`, and nothing is sent. The trading worker (`src/queue.js`, stored in a Durable Object) makes sure nobody is lost when that happens:

- **Who needs a slot:** only the first message to a new number. If ZeroSettle says the line is full, the lead waits. Messages to someone who was already messaged go straight through. More messages for someone who is still waiting are skipped until their first one goes out.
- **Order:** a tier from the contact's GoHighLevel tags, then newest first. With `CREATOR_TAG` `jean`:
  1. `jean-booked`
  2. `jean-applied`
  3. opted in
  4. `jean-not-qualified`

  Tags arrive with every webhook. A "status changed" workflow (trigger: `-applied`, `-booked` or `-not-qualified` added) POSTs to `/update` so the order stays current. An update that arrives before the opt-in message is remembered.
- **Never twice:** before a first message, the worker checks the line's ZeroSettle history for that number. If someone was already texted (by hand, or before the waitlist), they're marked sent and use no slot. So old leads can be re-run through the opt-in workflow safely.
- **Noon batch:** from `HOLD_FROM_HOUR` (3 AM, when ZeroSettle's day starts) until `SEND_HOUR` (noon), in `TIMEZONE`, opt-ins wait. That way the fresh day's slots go out together at noon in waitlist order. Applied and booked leads don't wait for the batch. An hourly cron sends the batch and retries anything temporary.
- **Booked calls:** a GoHighLevel workflow (trigger: tag `jean-booked` added) sends a Webhook to `/booked` with the same header and no `text`. Depending on where the lead is:
  - Still waiting: they move to the front.
  - Booked before their opt-in message arrived (the opt-in workflow waits 3 minutes): the booking is remembered, and they go to the front when the message arrives.
  - Already messaged: nothing happens.
- **ZeroSettle refusals,** by `error.code`:
  - `new_contact_limit` or `daily_limit` (line full): the lead keeps their place.
  - `unauthorized`, `payment_required`, `unknown_line`, `line_draining` (a setup problem): the lead keeps their place, and the worker retries hourly.
  - `recipient_opted_out`, `invalid_request`, `send_failed` (this person can't be messaged): the lead is marked failed.
  - `phone_offline`, `line_busy` (temporary): the worker retries hourly and marks the lead failed after 5 tries.
- **GoHighLevel tags:** with a `GHL_API_KEY` secret (a Private Integration token from the sub-account with the View/Edit Contacts scopes), each contact gets tagged `TAG_PREFIX` + `waiting`, `priority`, `sent` or `failed`. Without it, everything still works, just without tags.

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
