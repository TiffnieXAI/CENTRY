/**
 * Centry frontend API client.
 *
 * This is the ONE place that knows how to talk to the FastAPI backend. Every
 * page includes it via `<script src="assets/api.js"></script>` and uses the
 * global `Centry` object. It owns three concerns that used to be scattered
 * (or, before this file existed, simply faked with setTimeout):
 *
 *   1. WHERE the API is  — same-origin by default (the backend serves these
 *      pages at "/"), overridable with `window.CENTRY_API_BASE` for a
 *      separate dev server / file:// workflow. URLs are resolved explicitly
 *      so a page opened from disk doesn't accidentally build
 *      "file:///api/v1/...".
 *   2. AUTH               — the JWT lives in localStorage under "centry_token"
 *      and is attached as "Authorization: Bearer <token>". A 401 mid-session
 *      clears the token and bounces to signin.html?next=<where you were>.
 *   3. ERRORS             — any non-2xx response throws an ApiError whose
 *      `.message` is the backend's "detail", so pages can just
 *      `catch (err) { show(err.message) }`.
 *
 * Usage:
 *   Centry.requireAuth();                    // login wall - call first on protected pages
 *   await Centry.login(email, password);     // -> { access_token, token_type }
 *   await Centry.register({ email, password, full_name });
 *   await Centry.me();                       // -> { id, email, full_name, ... }
 *   await Centry.connections();              // -> [ { platform_type, status, ... } ]
 *   await Centry.startConnection("SHOPEE");  // fetch authorize URL + navigate
 *   Centry.wsUrl("/ws/events");              // -> "ws://host/ws/events?token=<jwt>"
 *   Centry.notify("Connected!", "error");    // bottom-right toast
 *
 * The backend's API root is /api/v1 — see Backend/README.md for the endpoint
 * catalogue, and Backend/app/routers/* for the authoritative contracts.
 */
(function () {
  "use strict";

  var TOKEN_KEY = "centry_token";

  // -------------------------------------------------------------------------
  // Base URL resolution
  // -------------------------------------------------------------------------
  // Priority: explicit override > same-origin (when served over http/https) >
  // localhost fallback (for file:// pages, which have no origin to reuse).
  function resolveApiBase() {
    if (typeof window !== "undefined" && window.CENTRY_API_BASE) {
      return String(window.CENTRY_API_BASE).replace(/\/+$/, "");
    }
    if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
      return window.location.origin;
    }
    return "http://localhost:8000";
  }

  var API_BASE = resolveApiBase();

  function apiUrl(path) {
    if (path.charAt(0) !== "/") path = "/" + path;
    return API_BASE + path;
  }

  // -------------------------------------------------------------------------
  // Token storage
  // -------------------------------------------------------------------------
  function getToken() {
    try { return window.localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(token) {
    try { window.localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* private mode */ }
  }
  function clearToken() {
    try { window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  // Thrown by request() for any non-2xx response. `.message` is the human
  // readable string the backend returned in {"detail": "..."} (or a fallback).
  function ApiError(message, status, detail) {
    this.name = "ApiError";
    this.message = message;
    this.status = status;      // HTTP status code, or 0 for network failures
    this.detail = detail;      // raw parsed body, when available
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  // The backend returns errors in two shapes:
  //   {"detail": "..."}                      - FastAPI HTTPException (401, 422, 502...)
  //   {"detail": [{loc, msg, ...}, ...]}     - request-validation errors (422)
  //   {"message": "..."}                     - the app's own Duplicate/NotFound
  //                                            handlers (409 / 404) in app/main.py
  // Flatten all three into a single readable string.
  function detailToMessage(detail, fallback) {
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail)) {
      return detail
        .map(function (d) {
          if (d && typeof d === "object") {
            var loc = Array.isArray(d.loc) ? d.loc.join(".") : "";
            return (loc ? loc + ": " : "") + (d.msg || "invalid value");
          }
          return String(d);
        })
        .join("; ");
    }
    return fallback;
  }

  // True for an HTML document body (starts with <!doctype, <html, ...). Used to
  // detect when something OTHER than the API answered our request.
  function looksLikeHtml(text) {
    return /^\s*<(!doctype|html|head|body|div|pre|title|meta|link|script)/i.test(text);
  }

  // Pick the human-readable field out of a parsed error body (detail, else
  // message), falling back to a status-based message.
  function extractErrorMessage(parsed, status) {
    var fallback = "Request failed (" + status + ")";
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.detail !== undefined) return detailToMessage(parsed.detail, fallback);
      if (parsed.message !== undefined) return detailToMessage(parsed.message, fallback);
    }
    // The backend always answers JSON, so a STRING body means JSON.parse
    // failed - i.e. something else (the static file server, a proxy, an error
    // page) responded instead of the API. NEVER dump that raw body into the
    // UI: it's page source, not a message. Show a clean, human-readable line
    // instead, with a hint when it's clearly an HTML page (usually a wrong
    // API base URL or the backend not running).
    if (typeof parsed === "string" && parsed) {
      if (looksLikeHtml(parsed)) {
        return "The server sent a web page instead of an API response. "
          + "Check that the Centry API is running at " + API_BASE + ".";
      }
      return fallback;
    }
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Core request wrapper
  // -------------------------------------------------------------------------
  // options:
  //   method  - HTTP method (default "GET")
  //   body    - plain object -> JSON-encoded; FormData / URLSearchParams /
  //             string sent as-is (with sensible Content-Type)
  //   auth    - attach the Bearer token (default true)
  //   redirectOn401 - bounce to signin on 401 (default true when auth is on)
  async function request(path, options) {
    options = options || {};
    var method = options.method || "GET";
    var body = options.body;
    var useAuth = options.auth !== false;
    var redirectOn401 = options.redirectOn401 !== undefined ? options.redirectOn401 : useAuth;

    var headers = {};
    var payload;

    if (body !== undefined && body !== null) {
      if (body instanceof FormData || body instanceof URLSearchParams || typeof body === "string") {
        payload = body; // let the browser set the multipart/urlencoded boundary
      } else {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
      }
    }

    var token = getToken();
    if (useAuth && token) {
      headers["Authorization"] = "Bearer " + token;
    }

    var res;
    try {
      res = await fetch(apiUrl(path), {
        method: method,
        headers: headers,
        body: payload,
      });
    } catch (networkErr) {
      // fetch only rejects on network-level failure (server down, DNS, CORS...).
      throw new ApiError(
        "Could not reach the Centry API at " + API_BASE + ". Is the backend running?",
        0,
        null
      );
    }

    // Parse the body once; the backend always answers JSON.
    var parsed = null;
    var rawText = await res.text();
    if (rawText) {
      try { parsed = JSON.parse(rawText); } catch (e) { parsed = rawText; }
    }

    if (!res.ok) {
      // A 401 on an authenticated call means the token is missing/expired/invalid.
      if (res.status === 401 && useAuth && token && redirectOn401) {
        clearToken();
        redirectToSignin();
      }
      throw new ApiError(extractErrorMessage(parsed, res.status), res.status, parsed);
    }

    return parsed;
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------
  function currentLocation() {
    return window.location.pathname + window.location.search;
  }

  function redirectToSignin() {
    var next = encodeURIComponent(currentLocation());
    window.location.href = "signin.html?next=" + next;
  }

  /**
   * Login wall. Call at the top of every protected page's script.
   * Returns true when a token exists (page may proceed); otherwise redirects
   * to signin.html?next=<current page> and returns false.
   */
  function requireAuth() {
    if (!getToken()) {
      redirectToSignin();
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Auth endpoints
  // -------------------------------------------------------------------------
  /**
   * POST /api/v1/auth/login
   * The backend uses OAuth2PasswordRequestForm, so this is form-encoded with
   * "username" = the email (see Backend/app/routers/auth.py). On success the
   * JWT is stored and subsequent requests are authenticated automatically.
   */
  async function login(email, password) {
    var form = new URLSearchParams();
    form.append("username", email);
    form.append("password", password);
    var data = await request("/api/v1/auth/login", {
      method: "POST",
      body: form,
      auth: false,
      redirectOn401: false, // a bad password should show an error, not redirect
    });
    if (data && data.access_token) setToken(data.access_token);
    return data;
  }

  /**
   * POST /api/v1/auth/register
   * payload: { email, password, full_name }. Note the backend only persists
   * these three fields today - the register page collects more (birthdate,
   * phone, business details, permit upload) that are NOT stored yet; see
   * Frontend/README.md. After a successful register the user is NOT
   * automatically logged in - call login() next.
   */
  async function register(payload) {
    return await request("/api/v1/auth/register", {
      method: "POST",
      body: {
        email: payload.email,
        password: payload.password,
        full_name: payload.full_name,
      },
      auth: false,
      redirectOn401: false,
    });
  }

  /** GET /api/v1/auth/me -> { id, email, full_name, is_active, created_at } */
  async function me() {
    return await request("/api/v1/auth/me");
  }

  /** Clear the token and send the user back to the sign-in page. */
  function logout(nextPath) {
    clearToken();
    window.location.href = "signin.html" + (nextPath ? "?next=" + encodeURIComponent(nextPath) : "");
  }

  // -------------------------------------------------------------------------
  // Platform OAuth (connect.html)
  // -------------------------------------------------------------------------
  /** GET /api/v1/oauth/connections -> [ { id, platform_type, status, ... } ] */
  async function connections() {
    return await request("/api/v1/oauth/connections");
  }

  /**
   * GET /api/v1/oauth/{platform}/authorize -> { authorize_url }, then send the
   * browser there. The seller approves on Shopee/Lazada/TikTok/Meta's own site;
   * the platform redirects back to the backend callback, which stores the
   * connection and bounces the browser to connect.html?connected=...&status=...
   * (see _back_to_connect in Backend/app/routers/oauth.py).
   */
  async function startConnection(platform) {
    var data = await request("/api/v1/oauth/" + encodeURIComponent(platform) + "/authorize");
    if (data && data.authorize_url) {
      window.location.href = data.authorize_url;
    }
    return data;
  }

  /** DELETE /api/v1/oauth/connections/{id} -> marks a connection disconnected. */
  async function disconnectConnection(connectionId) {
    return await request("/api/v1/oauth/connections/" + encodeURIComponent(connectionId), {
      method: "DELETE",
    });
  }

  // -------------------------------------------------------------------------
  // WebSockets
  // -------------------------------------------------------------------------
  // Browser WebSockets can't set an Authorization header, so both sockets take
  // the JWT as a ?token= query param (see get_current_user_ws in
  // Backend/app/core/deps.py).
  function wsUrl(path) {
    if (path.charAt(0) !== "/") path = "/" + path;
    var base = API_BASE.replace(/^http/, "ws"); // http->ws, https->wss
    var token = getToken() || "";
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return base + path + sep + "token=" + encodeURIComponent(token);
  }

  // -------------------------------------------------------------------------
  // Verification + chat + events (thin wrappers; see Backend/README.md)
  // -------------------------------------------------------------------------
  /** GET /api/v1/verification/sessions -> past Live Verify calls */
  function verificationSessions() {
    return request("/api/v1/verification/sessions");
  }
  /** GET /api/v1/verification/sessions/{id} -> one call + every audio window */
  function verificationSession(id) {
    return request("/api/v1/verification/sessions/" + encodeURIComponent(id));
  }

  /**
   * POST /api/v1/chat/sessions
   * opts: { verification_session_id?, language? } - pass a
   * verification_session_id to scope the chat to a Live Verify incident so the
   * chatbot can pull that incident's risk history as context.
   */
  function createChatSession(opts) {
    opts = opts || {};
    return request("/api/v1/chat/sessions", {
      method: "POST",
      body: {
        verification_session_id: opts.verification_session_id || null,
        language: opts.language || "en",
      },
    });
  }

  /**
   * POST /api/v1/chat/sessions/{id}/messages -> persists the user's message and
   * returns the assistant's reply (ChatMessageResponse).
   */
  function sendChatMessage(sessionId, content, language) {
    return request("/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/messages", {
      method: "POST",
      body: { content: content, language: language || null },
    });
  }

  /** GET /api/v1/chat/sessions/{id}/logs -> full conversation + metadata */
  function chatLogs(sessionId) {
    return request("/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/logs");
  }

  // -------------------------------------------------------------------------
  // Toast notifications
  // -------------------------------------------------------------------------
  // A tiny self-contained toast (bottom-right). Uses inline styles so it works
  // regardless of which Tailwind utilities a given page happens to load.
  var TOAST_COLORS = {
    info:    { bar: "#bec2ff", text: "#dae2fd" },
    success: { bar: "#4ade80", text: "#dcfce7" },
    error:   { bar: "#ffb4ab", text: "#ffe4e1" },
    warning: { bar: "#facc15", text: "#fef9c3" },
  };

  function ensureToastHost() {
    var host = document.getElementById("centry-toast-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "centry-toast-host";
    host.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:9999;display:flex;flex-direction:column;" +
      "gap:10px;align-items:flex-end;pointer-events:none;font-family:Inter,system-ui,sans-serif;";
    document.body.appendChild(host);
    return host;
  }

  function notify(message, type) {
    type = type || "info";
    var color = TOAST_COLORS[type] || TOAST_COLORS.info;

    var host = ensureToastHost();
    var toast = document.createElement("div");
    toast.style.cssText =
      "pointer-events:auto;min-width:220px;max-width:340px;background:rgba(23,31,51,0.96);" +
      "backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.12);" +
      "border-left:4px solid " + color.bar + ";border-radius:10px;padding:12px 14px;" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.45);color:" + color.text + ";" +
      "font-size:14px;line-height:1.4;opacity:0;transform:translateY(8px);" +
      "transition:opacity .2s ease, transform .2s ease;";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.style.cssText =
      "background:none;border:none;color:" + color.text + ";opacity:.6;cursor:pointer;" +
      "font-size:16px;line-height:1;padding:0 0 0 8px;float:right;margin-left:8px;";
    close.innerHTML = "&times;";
    close.onclick = function () { dismiss(); };

    toast.appendChild(close);
    toast.appendChild(document.createTextNode(message || ""));
    host.appendChild(toast);

    // Fade in.
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    var timer = setTimeout(dismiss, 5000);
    function dismiss() {
      clearTimeout(timer);
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 220);
    }
    return dismiss;
  }

  // -------------------------------------------------------------------------
  // Reusable AI chat widget wiring
  // -------------------------------------------------------------------------
  // Several pages ship an identical-looking "Centry AI" chat window with
  // slightly different element ids. initChat() wires any of them to the real
  // /api/v1/chat/* endpoints so we don't copy the same fetch logic five times.
  //
  // config:
  //   messagesId   - id of the scrollable message list element
  //   inputId      - id of the text input
  //   sendId       - id of the send button
  //   language     - "en" | "fil" | "tgl" (default "en")
  //   verificationSessionId - scope replies to a Live Verify incident (optional)
  //   greet        - optional function returning the opening assistant line
  //
  // Returns { send, appendMessage, setBusy } for the page to drive.
  function initChat(config) {
    var messagesEl = document.getElementById(config.messagesId);
    var inputEl = document.getElementById(config.inputId);
    var sendEl = document.getElementById(config.sendId);
    if (!messagesEl || !inputEl) {
      // Missing markup - don't crash the page, just make chat a no-op.
      return { send: function () {}, appendMessage: function () {}, setBusy: function () {} };
    }

    var sessionId = null;
    var busy = false;

    function now() {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    // role: "USER" -> right-aligned bubble, "ASSISTANT" -> left-aligned.
    function appendMessage(role, text) {
      var wrap = document.createElement("div");
      var isUser = role === "USER";
      wrap.className = isUser
        ? "flex flex-col items-end self-end max-w-[85%]"
        : "flex flex-col items-start max-w-[85%]";

      var bubble = document.createElement("div");
      bubble.className = isUser
        ? "bg-primary-container/40 p-sm rounded-lg rounded-tr-none border border-primary/20"
        : "bg-surface-variant p-sm rounded-lg rounded-tl-none border border-white/5";

      var p = document.createElement("p");
      p.className = "text-sm text-on-surface";
      p.style.whiteSpace = "pre-wrap";
      p.textContent = text;
      bubble.appendChild(p);

      var stamp = document.createElement("span");
      stamp.className = "text-[9px] font-label-sm text-on-surface-variant mt-1" + (isUser ? " text-right" : "");
      stamp.textContent = now();

      wrap.appendChild(bubble);
      wrap.appendChild(stamp);
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return wrap;
    }

    function setBusy(isBusy) {
      busy = isBusy;
      if (inputEl) inputEl.disabled = isBusy;
      if (sendEl) sendEl.disabled = isBusy;
    }

    async function send() {
      var text = (inputEl.value || "").trim();
      if (!text || busy) return;

      appendMessage("USER", text);
      inputEl.value = "";
      setBusy(true);

      try {
        // Lazily open a chat session on first send, so an idle chat window
        // doesn't create empty sessions in the DB.
        if (!sessionId) {
          var session = await createChatSession({
            verification_session_id: config.verificationSessionId || null,
            language: config.language || "en",
          });
          sessionId = session.id;
        }
        var reply = await sendChatMessage(sessionId, text, config.language || "en");
        appendMessage("ASSISTANT", reply.content || "(no reply)");
      } catch (err) {
        appendMessage("ASSISTANT", "Sorry, I couldn't reach the Centry AI service. " + (err.message || ""));
      } finally {
        setBusy(false);
      }
    }

    if (sendEl) sendEl.addEventListener("click", send);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    return { send: send, appendMessage: appendMessage, setBusy: setBusy, getSessionId: function () { return sessionId; } };
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------
  window.Centry = {
    API_BASE: API_BASE,
    ApiError: ApiError,

    // auth
    login: login,
    register: register,
    me: me,
    logout: logout,
    requireAuth: requireAuth,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,

    // platform oauth
    connections: connections,
    startConnection: startConnection,
    disconnectConnection: disconnectConnection,

    // verification / chat / events
    verificationSessions: verificationSessions,
    verificationSession: verificationSession,
    createChatSession: createChatSession,
    sendChatMessage: sendChatMessage,
    chatLogs: chatLogs,
    wsUrl: wsUrl,

    // misc
    request: request,
    notify: notify,
    initChat: initChat,
    redirectToSignin: redirectToSignin,
  };
})();
