# Centry Frontend

Static HTML pages (Tailwind via CDN, no build step) served by the FastAPI
backend.

## Running it

One process serves the pages and the API:

```bash
cd Backend
CENTRY_USE_SQLITE=true uvicorn app.main:app --reload
```

Open <http://localhost:8000/> - `/` redirects to `landing.html`. No CORS
config, no second dev server.

To run the pages from another origin instead, set the API base before
`assets/api.js` loads and allow that origin with
`CENTRY_CORS_ALLOWED_ORIGINS` (see `Backend/README.md`):

```html
<script>window.CENTRY_API_BASE = "http://localhost:8000";</script>
<script src="assets/api.js"></script>
```

## `assets/api.js` - the one place that talks to the backend

Every page that needs the API includes it and uses the `Centry` global.
It owns the three things that used to be scattered around:

| Concern | What api.js does |
|---|---|
| Where the API is | Same-origin by default; `window.CENTRY_API_BASE` overrides it. URLs are resolved explicitly so `file://` pages don't build `file:///api/...` by accident. |
| Auth | JWT in `localStorage` under `centry_token`, attached as `Authorization: Bearer ...`. A `401` mid-session clears it and bounces to `signin.html?next=<where you were>`. |
| Errors | Non-2xx throws `ApiError` with the backend's `detail` as `.message` - the pages just `catch (err)` and show `err.message`. |

Useful bits:

```js
Centry.requireAuth();                 // login wall - call first on protected pages
await Centry.login(email, password);  // form-encoded POST /api/v1/auth/login
await Centry.register({ email, password, full_name });
await Centry.me();                    // GET /api/v1/auth/me
await Centry.connections();           // GET /api/v1/oauth/connections
await Centry.startConnection("SHOPEE"); // authorize URL + navigate the browser
Centry.wsUrl("/ws/events");           // ws://...?token=<jwt>
Centry.notify("Connected!", "error"); // bottom-right toast
```

## Page wiring

| Page | Talks to | Status |
|---|---|---|
| `signin.html` | `POST /api/v1/auth/login` | ✅ wired |
| `register.html` | `POST /api/v1/auth/register`, then logs in automatically | ✅ wired |
| `connect.html` | `GET /api/v1/oauth/{platform}/authorize`, `GET /api/v1/oauth/connections` | ✅ wired |
| `otp.html` | nothing | ⚠️ placeholder - the backend has no OTP/email-verification endpoint yet, so this step is still simulated. Register already signs you in, so it can be skipped without breaking the flow. |
| `dashboard.html`, `incident.html`, `dailyReport.html`, `liveVerify.html`, `settings.html` | nothing yet | ⚠️ UI only (hardcoded numbers/rows). They load `api.js` for the login wall, and `settings.html`'s Logout button is wired to `Centry.logout()`. |

### The connect flow end to end

1. `connect.html` calls `Centry.startConnection("SHOPEE")` →
   `GET /api/v1/oauth/SHOPEE/authorize` → `{authorize_url}` → the browser
   navigates there.
2. The seller approves on Shopee/Lazada/TikTok's own site.
3. The platform redirects to `GET /api/v1/oauth/{platform}/callback`, which
   saves the connection and redirects back to
   `connect.html?connected=SHOPEE&status=connected` (or `status=error&detail=...`).
4. `connect.html` reads that query string, shows a banner, clears the query,
   and re-reads `GET /api/v1/oauth/connections` to mark the button connected.

Buttons whose platform the backend doesn't implement are rendered
"Coming soon" and disabled - driven by the absence of a `data-platform`
attribute, which must match a value of the backend's `PlatformType` enum
(`SHOPEE`, `LAZADA`, `TIKTOK_SHOP`, `META`). That's why Temu and Shein are
inert: there's no `POST /api/v1/oauth/temu/...` behind them.

## Adding a page

1. Put the `.html` file in `Frontend/pages/` - it's served at `/<name>.html`
   automatically.
2. Include `<script src="assets/api.js"></script>` before your own `<script>`
   (typically right before `</body>`).
3. Behind the login wall? Add `Centry.requireAuth();` at the top of your
   script - it redirects to `signin.html?next=...` when there's no token.
4. Fetch with `await Centry.request("/api/v1/...")` and render `err.message`
   on failure.
