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

## Commands

```bash
npm install
npm test         # unit tests (no network)
npm run deploy   # wrangler deploy
npm run logs     # live logs (wrangler tail)
```

Logs are kept in the dashboard as well: Workers & Pages → zerosettle-ghl-relay → **Logs**.
