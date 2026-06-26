# GTM Tags — API-only Hive tracking (replaces the SDK)

Two Custom HTML tags that send checkout data to **your collector** (`src/server.js`),
which forwards to Hive server-side. This removes the browser SDK entirely.

## Files
- `checkout-started.html` — abandoned cart (status `started`), real-time, captures returning/pre-filled users.
- `placed-order.html` — purchase (status `completed`), reuses the same order_id + event.

## Prerequisites
1. **Deploy the collector** to a public HTTPS URL (the browser can't reach `localhost`).
   Examples: a small VM, Render/Railway/Fly, or a GTM **server-side** container.
   Keep `.env` + `tokens.json` on that server only.
2. In the collector's `.env`, set the storefront origin so only your site can call it:
   ```
   COLLECTOR_ALLOWED_ORIGIN=https://www.bingoloco.com
   ```
3. In **both** HTML files, set `COLLECTOR_URL` to your deployed base URL, e.g.
   `https://collector.bingoloco.com` (no trailing slash).

## Set up in GTM
1. **Tags → New → Custom HTML.** Name it `Hive - Checkout Started (API)`, paste
   `checkout-started.html`. Trigger: fire on the **checkout page** — either the
   `begin_checkout` event, or DOM Ready scoped to the checkout URL path.
2. **Tags → New → Custom HTML.** Name it `Hive - Placed Order (API)`, paste
   `placed-order.html`. Trigger: the **`purchase`** event / order confirmation page.
3. **Pause the old SDK tags** (don't delete yet): `Hive init`, `Hive - Checkout Started`,
   `Hive - placed order`. Once the API tags are verified in production, delete them and
   remove the SDK loader.

## Test (GTM Preview)
1. Enter Preview, open the checkout page.
2. Type an email → within ~1s the collector should receive a `started` order
   (check the collector logs / Hive after a few minutes).
3. Reload as a returning user with autofilled fields → it should fire **without** a click.
4. Complete a purchase → a `completed` order with the **same** `order_id` and `event_id`.

## How it meets the requirements
- **Real-time abandoned cart:** fires on `input`/`change`/`blur` (debounced ~700ms), not on button click.
- **Returning users, pre-filled, no click:** fires on load + retries + Chrome/Edge autofill detection.
- **Fires regardless of opt-in:** the `started` order is always sent; `is_email_opt_in`
  carries the **real** checkbox value (not a hardcoded `true` like the old SDK).
- **No duplicates:** event_id is deterministic and the order_id is reused start→complete,
  so Hive upserts.

## Compliance note (read before go-live)
Sending abandoned-cart emails to people who entered an email but did **not** opt in is a
legal gray area, and Bingo Loco operates in Canada (**CASL**). The tag captures consent
accurately (`is_email_opt_in`), but confirm with whoever owns compliance whether you may
email non-opted-in abandoned carts before enabling that automation in Hive.
