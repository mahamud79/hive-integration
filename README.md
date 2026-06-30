# Hive API Integration (Backend Collector)

Pushes **events** and **orders** to the [Hive API (Beta)](https://api.hive.co/v2) using
OAuth 2.0 **Authorization Code Flow with PKCE**. This is the server-side piece that
replaces the browser SDK.

> **Why a backend?** The Hive API cannot be called from the browser/GTM: it uses OAuth
> with PKCE (no client-credentials flow) and the tokens/secret must never be exposed
> client-side. GTM sends data to *this* service; this service calls Hive.

## Requirements

- Node.js 20.6+ (uses built-in `--env-file` and global `fetch`; **no dependencies to install**)
- A Hive API partner `client_id` + `client_secret` from the
  [Partner Portal](https://app.hive.co/partners/portal/)

## Project layout

```
src/
  pkce.js         PKCE code_verifier / code_challenge / state
  authorize.js    one-time OAuth login -> saves tokens.json
  refresh.js      refresh access token (rotates refresh token)
  tokens.js       load/save tokens, expiry tracking
  event-id.js     canonical, deterministic event id (the core data fix)
  hive.js         authenticated API client (pushEvents / pushOrders / pushContacts)
  diagnose.js     preflight check for the invalid_client error
  push-event.js   test: POST /events
  push-order.js   test: POST /orders (started + completed)
  order-builder.js  normalizes a browser payload into Hive event + order
  server.js       HTTP collector (the GTM/browser endpoint -> Hive)
```

## Setup

```bash
cp .env.example .env      # then fill in HIVE_CLIENT_ID and HIVE_CLIENT_SECRET
```

Register this redirect URI in the Partner Portal (exact, no trailing slash):

```
http://localhost:3000/oauth/callback
```

## Commands

```bash
npm run diagnose              # validate client_id / build authorize URL (no portal needed)
npm run authorize             # one-time OAuth login -> writes tokens.json
npm run test:event            # POST /events  (expect 202)
npm run test:order            # POST /orders, status "started" (abandoned cart)
npm run test:order completed  # same order_id + event_id -> upsert to completed
npm run refresh               # manually refresh the access token
npm start                     # run the HTTP collector (the GTM/browser endpoint)
```

A `202` means "received and queued". Data appears in Hive asynchronously — usually
minutes, **up to 1 hour during beta**.

## The collector (`npm start`)

This is the server your storefront/GTM calls. It holds the OAuth tokens and forwards
to Hive server-side, so secrets never touch the browser. Routes:

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness check |
| `POST` | `/collect/order` | upsert the event, then push the order (started = abandoned cart, completed = purchase) |
| `POST` | `/collect/event` | upsert an event only |

Example — abandoned cart (status `started`):

```bash
curl -X POST http://localhost:8787/collect/order \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "started",
    "order_id": "order_1718900000000",
    "event": {
      "name": "Chelsea Theatre",
      "start_at": "2026-07-15T18:00:00Z",
      "url": "https://bingoloco.ca/experiences/chelsea-theatre",
      "venue": { "name": "Chelsea Theatre", "city": "Toronto", "country": "Canada" }
    },
    "user": { "email": "guest@example.com", "first_name": "Sam", "is_email_opt_in": false },
    "items": [{ "tier_name": "General Admission", "price": 25.0, "quantity": 2 }]
  }'
```

The same call with `"status": "completed"` and the **same `order_id`** upgrades it to a
purchase. Set `COLLECTOR_ALLOWED_ORIGIN` in `.env` to your storefront origin in production.

## How this fixes the three reported problems

| Problem | Cause | Fix |
|---|---|---|
| 1. Events have wrong id (event name used) | name jammed into the id slot | `buildEventId()` puts a stable slug in `event_id`, real name in `name` |
| 2. Orders show `evt_generic` | placeholder id on orders | order's `event_id = buildEventId(...)` — same id as its event |
| 3. SDK duplicates (same show, different ids) | SDK generated varying ids | deterministic id + Hive upsert-by-id => no duplicates |

`buildEventId(name, startAt)` -> `evt_<slug>_<YYYY-MM-DD>`. Same name + date always
produces the same id, so no event id needs to be stored in your database.

## Constraints (from the Hive Beta docs)

- **Async / eventually consistent**, up to 1h during beta. Confirm abandoned-cart
  automation latency with Hive before promising "real-time" emails.
- **Rate limits:** ~1 req/sec sustained (2 burst), **max 50 items per batch**, 1 MB body.
- **All-or-nothing batches:** if one item fails validation the whole batch is rejected (`422`).
- **Refresh tokens are single-use** and rotate — always persist the new one (`refresh.js` does).
- `event_id` on an order **must match an event** in Hive, so push events before orders.
- Order `items[].item_id` is **required** by the live API (the docs mark it optional).

## Next steps (not yet in this repo)

1. Wrap `pushEvents`/`pushOrders` in an HTTP endpoint (or GTM Server-Side container) the
   browser/GTM calls — the actual "API-only" collector.
2. Browser snippet to capture returning users with pre-filled forms (DOMContentLoaded +
   autofill detection) and fire the `started` order in real time.
3. Backfill scripts for the two CSVs (re-push orders with correct `event_id`; coordinate
   with Hive to remove the old name-keyed events).


## Deploying the collector (Render)

The collector must run on a public HTTPS URL for the browser/GTM to reach it.

1. Push this repo to GitHub (done) and create a Render **Web Service** from it.
2. Build command: `npm install` (there are no deps, but Render expects it). Start command: `npm start`.
3. Set environment variables in Render (from `.env.example`): `HIVE_CLIENT_ID`,
   `HIVE_CLIENT_SECRET`, `HIVE_AUTHORIZE_URL`, `HIVE_TOKEN_URL`, `HIVE_API_BASE`,
   `HIVE_SCOPES`, `COLLECTOR_ALLOWED_ORIGIN`, and
   `HIVE_REDIRECT_URI=https://YOUR-APP.onrender.com/oauth/callback`.
4. Register that same `https://YOUR-APP.onrender.com/oauth/callback` as a redirect URI
   in the Hive Partner Portal.
5. Authorize the server: open `https://YOUR-APP.onrender.com/oauth/start` in your
   browser, log into Hive, approve. Tokens are saved server-side.
6. Point the GTM tags' `COLLECTOR_URL` at `https://YOUR-APP.onrender.com`.

### Token persistence note
Tokens are written to `tokens.json` (or `TOKENS_FILE`). On Render's **free** tier the
disk is ephemeral and the service sleeps when idle, so a file-based token is lost on
restart and you'd re-run `/oauth/start`. Two durable options:
- **Free:** set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (a free Upstash
  Redis database). Tokens are then stored in Redis and survive restarts/sleeps.
- **Paid:** attach a Render **persistent disk** and set `TOKENS_FILE=/data/tokens.json`.
