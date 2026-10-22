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
It owns the three things that used to be scattered around (and, before this
file existed, were simply faked with `setTimeout`):

| Concern | What api.js does |
|---|---|
| Where the API is | Same-origin by default; `window.CENTRY_API_BASE` overrides it. URLs are resolved explicitly so `file://` pages don't build `file:///api/...` by accident. |
| Auth | JWT in `localStorage` under `centry_token`, attached as `Authorization: Bearer ...`. A `401` mid-session clears it and bounces to `signin.html?next=<where you were>`. |
| Errors | Non-2xx throws `ApiError` whose `.message` is the backend's readable error (see "Error shapes" below) - the pages just `catch (err)` and show `err.message`. |

Useful bits:

```js
Centry.requireAuth();                 // login wall - call first on protected pages
await Centry.login(email, password);  // form-encoded POST /api/v1/auth/login
await Centry.register({ email, password, full_name });
await Centry.me();                    // GET /api/v1/auth/me
Centry.logout();                      // clear token + go to signin.html
await Centry.connections();           // GET /api/v1/oauth/connections
await Centry.startConnection("SHOPEE"); // authorize URL + navigate the browser
await Centry.disconnectConnection(id);// DELETE /api/v1/oauth/connections/{id}
Centry.wsUrl("/ws/events");           // ws://...?token=<jwt>
Centry.notify("Connected!", "error"); // bottom-right toast
Centry.initChat({ messagesId, inputId, sendId, language }); // wire an AI chat widget
```

### Error shapes

The backend signals failures two ways, and `api.js` flattens both into
`ApiError.message` so pages never have to care:

- `{"detail": "..."}` - FastAPI `HTTPException` (401 bad login, 502 OAuth, ...).
- `{"detail": [{loc: ["body","email"], msg: "..."}, ...]}` - Pydantic
  validation errors (422), joined into `body.email: ...; ...`.
- `{"message": "..."}` - the app's own `DuplicateResourceException` /
  `ResourceNotFoundException` handlers in `Backend/app/main.py` (409 duplicate
  email, 404 not-found).

### Reusable AI chat widget (`Centry.initChat`)

Five pages ship the same floating "Centry AI" chat window with slightly
different element ids. Rather than duplicate the fetch logic five times, each
page calls `Centry.initChat` with its own ids:

```js
Centry.initChat({
  messagesId: 'dashboard-chat-messages', // scrollable message list
  inputId:    'dashboard-chat-input',    // text input
  sendId:     'dashboard-chat-send',     // send button
  language:   'en',                      // "en" | "fil" | "tgl"
  verificationSessionId: null,           // scope replies to a Live Verify call
});
```

It lazily opens a chat session on the first send (so an idle window doesn't
create empty sessions), then posts each message and renders the assistant's
reply. Enter sends; errors render inline.

## Page wiring

| Page | Talks to | Status |
|---|---|---|
| `signin.html` | `POST /api/v1/auth/login` | ✅ wired (real login; honors `?next=`) |
| `register.html` | `POST /api/v1/auth/register`, then `POST /api/v1/auth/login` | ✅ wired (validates password match/length client-side, then auto-signs-in) |
| `connect.html` | `GET /api/v1/oauth/{platform}/authorize`, `GET /api/v1/oauth/connections`, `GET /api/v1/auth/me` | ✅ wired (live connection states + OAuth result banner) |
| `otp.html` | nothing | ⚠️ placeholder - the backend has no OTP/email-verification endpoint yet, so this step is still simulated. Register already signs you in, so it can be skipped without breaking the flow. |
| `dashboard.html` | `WS /ws/events`, `Centry.initChat` -> `/api/v1/chat/*` | ✅ login wall + live activity feed from real events + AI chat |
| `incident.html` | `Centry.initChat` -> `/api/v1/chat/*` | ✅ login wall + AI chat (incident list itself is still hardcoded demo data - no backend endpoint for it yet) |
| `dailyReport.html` | `Centry.initChat` -> `/api/v1/chat/*` | ✅ login wall + AI chat (report numbers are still hardcoded - no reporting endpoint yet) |
| `liveVerify.html` | `WS /ws/live-verify`, `Centry.initChat` | ✅ login wall + real mic capture streamed to the backend + live risk gauge |
| `settings.html` | `GET /api/v1/auth/me`, `POST /api/v1/chat/*`, logout | ✅ login wall + real profile (name/email) + logout + AI chat |

### What the backend stores on register

`register.html` collects more than the API accepts. Only **email**, **password**,
and **full_name** (built from Given Name + Surname) are sent and persisted -
see `UserRegister` in `Backend/app/schemas/auth.py`. The other fields
(birthdate, phone, business name/type, permit upload) are collected in the UI
but **not stored yet**; wiring them needs a backend schema + migration change.


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
inert: there's no `POST /api/v1/oauth/temu/...` behind them. Every supported
button (including the **Meta** button, backed by `app/core/oauth/meta.py`)
carries a `data-platform` attribute so the page stays in sync with the enum.

### Live Verify streaming format

`liveVerify.html` streams the mic to `WS /ws/live-verify` as raw **mono 16 kHz
signed 16-bit PCM**, in **~1 second chunks** (`TARGET_SAMPLE_RATE` /
`CHUNK_MS` at the top of the page script). Capture uses `getUserMedia` +
a `ScriptProcessorNode` that downsamples float32 input to PCM16 before each
flush; clicking the mic again (or the socket closing) sends the text `END` to
complete the session. Each chunk gets a `risk_update` frame back, which drives
the threat gauge via `window.updateThreatUI(score)`. The backend's AI models
are still stubs, so the exact encoding is a documented default rather than a
hard requirement - revisit when real models land.

## Adding a page

1. Put the `.html` file in `Frontend/pages/` - it's served at `/<name>.html`
   automatically.
2. Include `<script src="assets/api.js"></script>` before your own `<script>`
   (typically right before `</body>`).
3. Behind the login wall? Add `Centry.requireAuth();` at the top of your
   script - it redirects to `signin.html?next=...` when there's no token.
4. Fetch with `await Centry.request("/api/v1/...")` and render `err.message`
   on failure.
5. Shipping an AI chat window? Give its message list / input / send button
   ids and call `Centry.initChat({ messagesId, inputId, sendId, language })`
   instead of hand-rolling the fetch loop.
