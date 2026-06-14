// factradar-ingest — multi-tenant WhatsApp companion-device listener.
// Each visitor links their OWN WhatsApp account (its own QR / session), and gets
// fact-check verdicts in their own "Message Yourself" chat. Sessions are isolated:
// one Baileys socket + one auth folder per user, keyed by an unguessable session id.

import express from "express";
import pino from "pino";
import qrcode from "qrcode";
import { randomUUID } from "node:crypto";
import { readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { recordEvent, upsertDevice, reconcileLinked, isJidLinked } from "./audit.js";

const AUTH_DIR = process.env.AUTH_DIR || "./auth"; // MUST be on a persistent volume in prod
const CORE_URL = process.env.CORE_URL || "http://localhost:41820";
const PORT = process.env.PORT || 41734;
// Skip media bigger than this (bytes) — big videos are slow to download/transcribe.
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 20 * 1024 * 1024);
// Plain text volume in busy groups is huge; by default only media is fact-checked.
const PROCESS_TEXT = (process.env.PROCESS_TEXT || "false").toLowerCase() === "true";
// Cap concurrent linked accounts (each is a live socket). Protects the host.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 50);
// Cap how many new sessions one IP can create per hour (anti-abuse on a public URL).
const LINK_PER_IP_PER_HOUR = Number(process.env.LINK_PER_IP_PER_HOUR || 5);
// Tear down a session that never finishes linking after this many ms.
const UNLINKED_TTL_MS = Number(process.env.UNLINKED_TTL_MS || 10 * 60 * 1000);
// Where the admin console lives (the header "Admin login" link points here).
const ADMIN_URL = process.env.ADMIN_URL || "http://localhost:41900";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// sid -> { sock, saveCreds, connState, latestQR, jid, sentIds, createdAt }
const SESSIONS = new Map();
// sid -> { prevSid, ts }: a "link another" attempt that turned out to be an
// already-listed account; the landing reads this to show "already listed" and
// restore the browser to its original session.
const recentlyRejected = new Map();

mkdirSync(AUTH_DIR, { recursive: true });

// ---- session lifecycle ----------------------------------------------------

async function startSession(sid) {
  const authPath = join(AUTH_DIR, sid);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const existing = SESSIONS.get(sid);
  const sess = existing || {
    connState: "init",
    latestQR: null,
    jid: null,
    sentIds: new Set(),
    recentMsgs: new Map(), // message_id -> raw message, for reply-quoting verdicts
    createdAt: Date.now(),
  };
  SESSIONS.set(sid, sess);
  // Resuming an already-registered account at boot: count its next "open" as a
  // reconnect, not a fresh link. (The 515 reconnect mid-pairing reuses the live
  // sess object, so linkedRecorded stays false there until the first real open.)
  if (!existing && state?.creds?.registered) sess.linkedRecorded = true;

  const log = logger.child({ sid });
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: log,
    browser: ["FactRadar", "Chrome", "1.0.0"],
  });
  sess.sock = sock;
  sess.saveCreds = saveCreds;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      if (sess.latestQR) {
        // A second QR means the first expired unscanned. Rather than rotate the code,
        // end the session so the user must return to the start and re-accept the Terms.
        // This stops one consent from minting an endless stream of shareable QR codes.
        log.info("QR expired unscanned — ending session");
        destroySession(sid, true);
        return;
      }
      sess.latestQR = await qrcode.toDataURL(qr);
      sess.connState = "qr";
      recordEvent("qr_generated", { sid });
    }
    if (connection === "open") {
      sess.connState = "open";
      sess.everOpen = true;
      sess.latestQR = null;
      sess.jid = jidNormalizedUser(sock.user?.id);
      log.info({ jid: sess.jid }, "WhatsApp connected");
      // Duplicate check (only for a brand-new link, not a reconnect): if this
      // account is ALREADY listed — a live session with the same jid, OR a device
      // recorded as "linked" in the DB under another session (survives restarts) —
      // it's already on FactRadar. Log out this extra device and flag the browser
      // so the landing can say "already listed".
      if (!sess.linkedRecorded) {
        const dupLive = [...SESSIONS].some(
          ([osid, o]) => osid !== sid && o.connState === "open" && o.jid === sess.jid
        );
        const dupDb = await isJidLinked(sess.jid, sid);
        if (dupLive || dupDb) {
          log.warn({ sid, jid: sess.jid }, "account already listed — logging out duplicate device");
          recordEvent("duplicate_link_rejected", { sid, jid: sess.jid });
          upsertDevice(sid, { status: "rejected_duplicate", jid: sess.jid, unlinkedAt: new Date() });
          recentlyRejected.set(sid, { prevSid: sess.prevSid || null, ts: Date.now() });
          try { await sock.logout(); } catch (e) { log.error(e, "duplicate logout failed"); }
          destroySession(sid, true);
          return;
        }
      }
      // First successful link vs. a reconnect of an already-registered account.
      if (!sess.linkedRecorded) {
        sess.linkedRecorded = true;
        recordEvent("linked", { sid, jid: sess.jid });
        upsertDevice(sid, {
          status: "linked",
          jid: sess.jid,
          linkedAt: new Date(),
          lastSeenAt: new Date(),
        });
      } else {
        recordEvent("reconnected", { sid, jid: sess.jid });
        upsertDevice(sid, { status: "linked", jid: sess.jid, lastSeenAt: new Date() });
      }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // 515 = restartRequired: the normal step right AFTER a QR scan — Baileys must
      // reconnect to finish login. Destroying here breaks pairing ("Couldn't log in").
      const restartRequired = code === DisconnectReason.restartRequired;
      const wasLinked = sess.everOpen || sock.authState?.creds?.registered;
      log.warn({ code, loggedOut, restartRequired, wasLinked }, "connection closed");
      if (loggedOut) {
        recordEvent("unlinked", { sid, jid: sess.jid, detail: { reason: "logged_out" } });
        upsertDevice(sid, { status: "unlinked", unlinkedAt: new Date() });
        destroySession(sid, true);
      } else if (restartRequired || wasLinked) {
        // finish pairing, or reconnect a linked account that briefly dropped
        if (restartRequired) {
          sess.latestQR = null;
          sess.connState = "linking";
        } else {
          sess.connState = "close";
        }
        startSession(sid).catch((e) => log.error(e, "reconnect failed"));
      } else {
        // never linked and the QR window closed — start over (re-accept Terms)
        destroySession(sid, true);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handleMessage(sid, sess, m);
      } catch (e) {
        log.error(e, "handleMessage failed");
      }
    }
  });

  return sess;
}

function destroySession(sid, deleteAuth = false) {
  const sess = SESSIONS.get(sid);
  if (sess?.sock) {
    try { sess.sock.end(); } catch { /* ignore */ }
  }
  SESSIONS.delete(sid);
  if (deleteAuth) {
    const p = join(AUTH_DIR, sid);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

// Periodically drop sessions that opened a QR but were NEVER linked, so abandoned
// tabs / crawlers don't pile up live sockets and empty auth folders. A session
// that has EVER linked is never swept — even if it's momentarily disconnected and
// reconnecting — otherwise we'd delete its auth and orphan the device on WhatsApp.
setInterval(() => {
  for (const [sid, sess] of SESSIONS) {
    const everLinked =
      sess.everOpen ||
      sess.linkedRecorded ||
      sess.sock?.authState?.creds?.registered;
    const linkingInProgress = sess.connState === "open" || sess.connState === "linking";
    if (!everLinked && !linkingInProgress && Date.now() - sess.createdAt > UNLINKED_TTL_MS) {
      logger.info({ sid }, "sweeping never-linked session");
      recordEvent("session_swept", { sid, detail: { reason: "never_linked_ttl" } });
      upsertDevice(sid, { status: "abandoned", abandonedAt: new Date() });
      destroySession(sid, true);
    }
  }
  // Drop stale "already listed" markers the browser never came back to read.
  for (const [sid, r] of recentlyRejected) {
    if (Date.now() - r.ts > 10 * 60 * 1000) recentlyRejected.delete(sid);
  }
}, 60 * 1000).unref();

// ---- message handling -----------------------------------------------------

function extractText(message) {
  const msg = message.message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    null
  );
}

function mediaType(message) {
  const msg = message.message || {};
  if (msg.imageMessage) return "image";
  if (msg.videoMessage) return "video";
  if (msg.audioMessage) return "audio"; // voice notes + audio files
  if (msg.conversation || msg.extendedTextMessage) return "text";
  return "other";
}

function mediaMimetype(message) {
  const msg = message.message || {};
  return (
    msg.imageMessage?.mimetype ||
    msg.videoMessage?.mimetype ||
    msg.audioMessage?.mimetype ||
    null
  );
}

async function downloadMediaB64(sess, m, type) {
  if (!["image", "video", "audio"].includes(type)) return null;
  try {
    const buf = await downloadMediaMessage(
      m,
      "buffer",
      {},
      { logger, reuploadRequest: sess.sock.updateMediaMessage }
    );
    if (buf.length > MAX_MEDIA_BYTES) {
      logger.warn({ bytes: buf.length, max: MAX_MEDIA_BYTES, type }, "media too big — skipping");
      return null;
    }
    return buf.toString("base64");
  } catch (e) {
    logger.error(e, "media download failed");
    return null;
  }
}

function rememberSent(sess, id) {
  if (!id) return;
  sess.sentIds.add(id);
  if (sess.sentIds.size > 500) sess.sentIds.delete(sess.sentIds.values().next().value);
}

function selfJids(sock) {
  const me = new Set();
  if (sock?.user?.id) me.add(jidNormalizedUser(sock.user.id));
  if (sock?.user?.lid) me.add(jidNormalizedUser(sock.user.lid));
  return me;
}

async function handleMessage(sid, sess, m) {
  if (!m.message) return;
  const jid = m.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  // Own outbound is ignored — EXCEPT the user's own "Message Yourself" chat, so
  // they can forward suspicious media to themselves for checking.
  if (m.key.fromMe) {
    if (!selfJids(sess.sock).has(jid)) return;
    if (sess.sentIds.has(m.key.id)) return; // our own verdict posts — avoid loops
    const caption = extractText(m) || "";
    if (caption.includes("_auto-checked") || caption.includes("FactRadar verdict")) return;
  }

  const type = mediaType(m);
  const payload = {
    session_id: sid,
    message_id: m.key.id,
    chat_id: jid,
    is_group: jid.endsWith("@g.us"),
    sender_id: m.key.participant || jid,
    type,
    text: extractText(m),
    media_b64: await downloadMediaB64(sess, m, type),
    mimetype: mediaMimetype(m),
    timestamp: Number(m.messageTimestamp) || Date.now() / 1000,
  };

  logger.info({ sid, type: payload.type, hasMedia: !!payload.media_b64 }, "message received");

  // Media always goes to core (OCR/transcription there). Text is forwarded only if
  // PROCESS_TEXT is on, OR it contains a link (core downloads the video / reads the
  // page and fact-checks it — YouTube, X, Facebook, Instagram, TikTok, articles…).
  const hasLink = payload.text && /https?:\/\/\S+/i.test(payload.text);
  if (!payload.media_b64 && !hasLink && !(PROCESS_TEXT && payload.text)) return;

  // Remember the original so the verdict can reply-quote it (tag what was checked).
  sess.recentMsgs.set(m.key.id, m);
  if (sess.recentMsgs.size > 200) sess.recentMsgs.delete(sess.recentMsgs.keys().next().value);

  // Audit: a checkable message was forwarded to core for this device.
  recordEvent("message_received", {
    sid,
    jid: sess.jid,
    detail: {
      type: payload.type,
      has_media: !!payload.media_b64,
      has_link: !!hasLink,
      is_group: payload.is_group,
      chat_id: jid,
    },
  });
  upsertDevice(sid, { lastSeenAt: new Date() }, { messages_received_total: 1 });

  try {
    const res = await fetch(`${CORE_URL}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.error({ status: res.status }, "core /ingest returned error");
  } catch (e) {
    logger.error(e, "failed to reach core");
  }
}

// ---- HTTP control surface -------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", true); // behind Railway's proxy — get the real client IP for consent logs
app.use(express.json({ limit: "64mb" })); // verdicts carry the checked media back
app.use(express.urlencoded({ extended: false })); // the terms-agreement form
app.use(express.static(join(__dirname, "public"))); // /logo.png, /favicon.png

// Bump when the Terms text materially changes — recorded with each consent.
const TERMS_VERSION = "2026-06-13";

function getCookie(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setSidCookie(res, sid) {
  res.cookie("fr_sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}

// Resolve the caller's session from cookie (preferred) or ?sid= (manual/testing).
function sessionOf(req) {
  const sid = getCookie(req, "fr_sid") || req.query.sid;
  return sid ? { sid, sess: SESSIONS.get(sid) } : { sid: null, sess: null };
}

// Single public URL: everything (landing → QR → linked) renders at "/" so the user
// never sees a path change. The centre card swaps based on their session state.
app.get("/", (req, res) => {
  // A "link another" attempt that turned out to be an already-listed account:
  // show the message, and restore the browser to its original session if it's
  // still live (so it keeps showing connected).
  const cookieSid = getCookie(req, "fr_sid");
  if (cookieSid && recentlyRejected.has(cookieSid)) {
    const { prevSid } = recentlyRejected.get(cookieSid);
    recentlyRejected.delete(cookieSid);
    if (prevSid && SESSIONS.get(prevSid)?.connState === "open") {
      setSidCookie(res, prevSid);
    } else {
      res.clearCookie("fr_sid");
    }
    return res.send(qrPage(alreadyListedCta()));
  }
  const { sess } = sessionOf(req);
  // A link this browser just started — keep the QR scannable until it finishes.
  if (sess && sess.latestQR) {
    // poll: redirect back to "/" if the QR expires (re-accept Terms), reload on success.
    return res.send(
      qrPage(
        `<img src="${sess.latestQR}" alt="WhatsApp link QR code"/>
      <div class="steps">
        <b>1.</b> Open WhatsApp on the phone you want to protect<br/>
        <b>2.</b> Tap <b>Settings &rarr; Linked devices &rarr; Link a device</b><br/>
        <b>3.</b> Scan now — the code is single-use and expires shortly
      </div>`,
        { poll: true, state: sess.connState }
      )
    );
  }
  // Mid-handshake (just after consent / just after a scan): show progress + poll.
  if (sess && (sess.connState === "linking" || sess.connState === "init")) {
    const msg = sess.connState === "linking"
      ? "🔗 Linking your account…"
      : "⏳ Preparing your secure code…";
    return res.send(qrPage(`<div class="status">${msg}</div>`, { poll: true, state: sess.connState }));
  }
  // Otherwise ALWAYS show the same "Protect My WhatsApp" entry, so a second person
  // sharing this laptop can link their own account. If this browser already has an
  // active link we note it — but never block linking another.
  const connected = !!(sess && sess.connState === "open");
  // Poll on the connected view too, so the page stays in sync if the session
  // drops or changes elsewhere (re-renders to the correct state automatically).
  res.send(qrPage(landingCta(connected), connected ? { poll: true, state: "open" } : {}));
});

function landingCta(connected) {
  // The central panel ALWAYS shows the same content. (Re-linking is safe now: the
  // /agree guard reuses this browser's existing session instead of adding another
  // WhatsApp device.) When already connected we just surface the status in a popup
  // so the panel text never changes; Unlink lives in the footer.
  // Panel text is identical whether or not connected. When connected, clicking
  // "Protect My WhatsApp" opens an info popup instead of starting a new link. The
  // popup is hidden by default and ONLY opens on that click — never on its own.
  const btn = connected
    ? `<a class="btn" href="/terms?consent=1" onclick="frModal(true);return false;">Protect My WhatsApp &rarr;</a>`
    : `<a class="btn" href="/terms?consent=1">Protect My WhatsApp &rarr;</a>`;
  const cta = `<div class="cta">Truth needs a guardian — be one! \u{1F6E1}\u{FE0F}</div>
      ${btn}
      <div class="steps" style="margin-top:20px">Links <b>your own</b> account. Takes ten seconds. Free.</div>`;
  if (!connected) return cta;
  return `${cta}
      <div id="frModal" class="modal-overlay" onclick="if(event.target===this)frModal(false)">
        <div class="modal">
          <div class="modal-msg">✅ This browser already has a WhatsApp <b>linked and active</b>.<br/>
            Do you want to link <b>another</b> device?</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="frModal(false)">No</button>
            <a class="btn" href="/terms?consent=1&amp;another=1">Yes, link another &rarr;</a>
          </div>
        </div>
      </div>
      <script>function frModal(s){document.getElementById('frModal').style.display=s?'flex':'none';}</script>`;
}

// Shown when a "link another" scan turns out to be an account already on FactRadar.
function alreadyListedCta() {
  return `<div class="status" style="padding:6px 4px 14px">ℹ️ <b>This device is already listed.</b><br/>
        That WhatsApp account is already linked to FactRadar, so we didn't add it again —
        the extra device has been removed from your WhatsApp.</div>
      <a class="btn" href="/">Back</a>`;
}

// Back-compat: the QR used to live here; keep the URL off-screen.
app.get("/qr", (_req, res) => res.redirect("/"));

// Terms of Service. Read-only when reached from the Terms/Privacy nav links;
// the consent checkbox + Agree/Decline only appear in the linking flow
// (?consent=1, from the "Protect My WhatsApp" button).
app.get("/terms", (req, res) => {
  res.send(termsPage({ consent: req.query.consent === "1", another: req.query.another === "1" }));
});

// Per-IP throttle on session creation (anti-abuse). In-memory, hourly window.
const linkAttempts = new Map();
function tooManyLinks(ip) {
  const now = Date.now();
  const arr = (linkAttempts.get(ip) || []).filter((t) => t > now - 3600 * 1000);
  if (arr.length >= LINK_PER_IP_PER_HOUR) {
    linkAttempts.set(ip, arr);
    return true;
  }
  arr.push(now);
  linkAttempts.set(ip, arr);
  return false;
}

// User accepted the Terms — record proof of consent, then create their session.
app.post("/agree", async (req, res) => {
  if (req.body.agree !== "yes") return res.redirect("/terms");
  // Don't add a SECOND WhatsApp device. A new device is created only when we mint
  // a new auth folder and scan a fresh QR. So if this browser already maps to a
  // session folder on disk (registered OR mid-link), REUSE it — reconnect the
  // SAME device, no new QR. This is durable across ingest restarts (unlike the
  // in-memory session map). A new link happens only when there is no existing
  // folder, or the user explicitly chose "link a different account".
  const existingSid = getCookie(req, "fr_sid");
  const wantsAnother = req.body.another === "yes";
  if (existingSid && !wantsAnother && existsSync(join(AUTH_DIR, existingSid))) {
    if (!SESSIONS.has(existingSid)) {
      try { await startSession(existingSid); }
      catch (e) { logger.error(e, "resume-on-agree failed"); }
    }
    return res.redirect("/");
  }

  if (tooManyLinks(req.ip)) {
    return res
      .status(429)
      .send(qrPage(`<div class="status">Too many link attempts from your network. Please try again in a little while.</div>`));
  }
  if (SESSIONS.size >= MAX_SESSIONS) {
    return res
      .status(503)
      .send(qrPage(`<div class="status">We're at capacity right now — please try again soon.</div>`));
  }
  const sid = randomUUID();
  try {
    await startSession(sid);
  } catch (e) {
    logger.error(e, "failed to start session");
    return res.status(500).send(qrPage(`<div class="status">Something went wrong — please retry.</div>`));
  }
  // Auditable consent record (timestamp + IP + UA + terms version).
  const sess = SESSIONS.get(sid);
  // For a "link another" attempt, remember the session this browser was viewing
  // so we can restore it if the new scan turns out to be an already-listed account.
  if (wantsAnother && existingSid) sess.prevSid = existingSid;
  sess.consent = {
    at: new Date().toISOString(),
    ip: req.ip,
    ua: req.headers["user-agent"] || "",
    termsVersion: TERMS_VERSION,
  };
  logger.info({ sid, ip: req.ip, termsVersion: TERMS_VERSION }, "user accepted terms");
  // Audit: create the device registry doc + log the consent event (proof of consent).
  upsertDevice(sid, { status: "linking", consent: sess.consent });
  recordEvent("consent_accepted", {
    sid,
    detail: { ip: req.ip, ua: sess.consent.ua, termsVersion: TERMS_VERSION },
  });

  setSidCookie(res, sid);
  res.redirect("/");
});

app.get("/status", (req, res) => {
  const { sess } = sessionOf(req);
  res.json({ state: sess?.connState || "none", sessions: SESSIONS.size });
});

// Unlinking is a two-step flow: GET shows the steps + a confirm button (so a
// stray link/prefetch can't silently disconnect someone); POST does it.
app.get("/unlink", (req, res) => {
  const { sess } = sessionOf(req);
  res.send(unlinkPage(!!(sess && sess.connState === "open")));
});

app.post("/unlink", (req, res) => {
  const { sid, sess } = sessionOf(req);
  if (sid) {
    recordEvent("unlinked", { sid, jid: sess?.jid, detail: { reason: "user_requested" } });
    upsertDevice(sid, { status: "unlinked", unlinkedAt: new Date() });
    destroySession(sid, true);
  }
  res.clearCookie("fr_sid");
  res.redirect("/");
});

// core calls this to deliver a verdict back to the right session.
// jid "me" = that session's own "Message Yourself" chat.
app.post("/send", async (req, res) => {
  const { session_id, jid, text, media_b64, mimetype, media_type, reply_to } = req.body || {};
  const sess = session_id ? SESSIONS.get(session_id) : null;
  if (!sess || sess.connState !== "open") return res.status(503).json({ error: "session not connected" });
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const dest = !jid || jid === "me" ? sess.jid : jid;
    let content = { text };
    if (media_b64 && (media_type === "image" || media_type === "video")) {
      const buf = Buffer.from(media_b64, "base64");
      content =
        media_type === "image"
          ? { image: buf, caption: text, ...(mimetype ? { mimetype } : {}) }
          : { video: buf, caption: text, ...(mimetype ? { mimetype } : {}) };
    }
    // Quote the original message so the verdict is tagged to what was checked.
    const opts = {};
    const quoted = reply_to && sess.recentMsgs?.get(reply_to);
    if (quoted) opts.quoted = quoted;
    const sent = await sess.sock.sendMessage(dest, content, opts);
    rememberSent(sess, sent?.key?.id);
    recordEvent("verdict_sent", {
      sid: session_id,
      jid: sess.jid,
      detail: {
        has_media: !!media_b64,
        is_reply: !!quoted,
        chars: text.length,
        preview: text.slice(0, 140),
      },
    });
    upsertDevice(session_id, { lastSeenAt: new Date() }, { verdicts_sent_total: 1 });
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "send failed");
    res.status(500).json({ error: String(e) });
  }
});

// Shared chrome (same header + footer on every page) ----------------------
const HEAD_TAGS = `<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<link rel="apple-touch-icon" href="/logo.png"/>`;

const CHROME_CSS = `
  /* thin single-line LIGHT bars top + bottom (the logo's green radar needs a
     light backdrop to read); both stay out of the way so the page remains a
     single no-scroll viewport on desktop */
  .site-header { flex:0 0 auto; height:50px; display:flex; align-items:center; justify-content:space-between;
                 padding:0 clamp(14px,3vw,32px); background:#ffffff; color:#1e293b; z-index:30;
                 border-bottom:1px solid #e6e9f0; box-shadow:0 1px 8px rgba(2,6,23,.05); }
  .site-header .lock { display:flex; align-items:center; gap:9px; text-decoration:none; }
  .site-header .lock img { width:34px; height:34px; display:block; }
  /* wordmark: "Fact" = the CTA-button indigo, "Radar" = red */
  .site-header .lock .wm { font-weight:800; font-size:1.08rem; letter-spacing:-.3px; color:#4f46e5; }
  .site-header .lock .wm b { color:#dc2626; }
  .site-header nav { display:flex; align-items:center; gap:clamp(12px,2.4vw,22px); }
  .site-header nav a { color:#5b6b80; text-decoration:none; font-size:.88rem; font-weight:600; }
  .site-header nav a:hover { color:#1e293b; }
  .site-header nav a.admin-link { border:1px solid #cbd5e1; color:#475569; padding:7px 14px; border-radius:8px; }
  .site-header nav a.admin-link:hover { border-color:#4f46e5; color:#4f46e5; }
  .site-footer { flex:0 0 auto; min-height:42px; background:#f6f8fb; color:#5b6b80; z-index:30;
                 padding:0 clamp(14px,3vw,32px); display:flex; align-items:center;
                 justify-content:space-between; gap:6px 18px; font-size:.78rem; line-height:1.3;
                 border-top:1px solid #e6e9f0; }
  .site-footer a { color:#475569; text-decoration:none; }
  .site-footer a:hover { color:#4f46e5; }
  .site-footer .fl { display:flex; gap:14px; }
  .site-footer .cr { opacity:.9; }
  @media (max-width:640px) {
    .site-header nav { gap:12px; }
    .site-header nav a.admin-link { padding:6px 11px; }
    /* on phones the footer may wrap to two short lines — that's fine when scrolling */
    .site-footer { flex-wrap:wrap; justify-content:center; text-align:center; padding:8px clamp(14px,3vw,32px); }
    .site-footer .fl { flex-wrap:wrap; justify-content:center; }
  }`;

function siteHeader() {
  return `<header class="site-header">
    <a class="lock" href="/"><img src="/logo.png" alt="FactRadar logo"/><span class="wm">Fact<b>Radar</b></span></a>
    <nav>
      <a href="/">Home</a>
      <a href="/terms">Terms</a>
      <a class="admin-link" href="${ADMIN_URL}/login">Admin login</a>
    </nav>
  </header>`;
}

function siteFooter() {
  return `<footer class="site-footer">
    <div class="fl">
      <a href="/">Home</a>
      <a href="/terms">Terms of Use</a>
      <a href="/terms#privacy">Privacy</a>
      <a href="/unlink">Unlink account</a>
    </div>
    <div class="cr">© 2026 FactRadar · Educational project · Not affiliated with WhatsApp/Meta.</div>
  </footer>`;
}

function qrPage(centerHtml, { poll = false, state = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_TAGS}
<title>FactRadar — Save truth. Save democracy.</title>
<style>
  :root { --ink:#1e293b; --muted:#5b6b80; --accent:#4f46e5; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; overflow:hidden; }
  body { font-family:'Segoe UI', system-ui, -apple-system, sans-serif; color:var(--ink);
         display:flex; flex-direction:column; min-height:100vh; }
${CHROME_CSS}

  /* four colourful tiles fill the area between header and footer; card floats centred */
  .wrap { position:relative; flex:1 1 auto; min-height:0; width:100%; display:grid;
          grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; }

  .tile { position:relative; padding:clamp(20px,4vmin,60px); display:flex; flex-direction:column;
          gap:clamp(6px,1vmin,14px); color:#fff; overflow:hidden; }
  .tile .art, .tile h3, .tile p, .tile .more { position:relative; z-index:2; }
  .tile .art { line-height:1; }
  .tile .art svg { width:clamp(54px,9vmin,118px); height:auto; }
  .tile h3 { font-size:clamp(1.05rem,2.6vmin,1.9rem); font-weight:800; letter-spacing:-.3px; }
  .tile p { font-size:clamp(.8rem,1.65vmin,1.06rem); line-height:1.5; max-width:42ch; opacity:.92; }
  .tile .more { font-weight:800; font-size:clamp(.82rem,1.6vmin,1.08rem); margin-top:clamp(4px,.8vmin,10px);
                background:rgba(255,255,255,.2); padding:6px 14px; border-radius:999px; display:inline-block; }
  /* push each tile's text to its outer corner so the centre card doesn't cover it */
  .tl { align-items:flex-start; justify-content:flex-start; text-align:left; }
  .tr { align-items:flex-end;   justify-content:flex-start; text-align:right; }
  .bl { align-items:flex-start; justify-content:flex-end;   text-align:left; }
  .br { align-items:flex-end;   justify-content:flex-end;   text-align:right; }
  .t-amber { background:linear-gradient(135deg,#fbbf24,#f59e0b); }
  .t-sky   { background:linear-gradient(135deg,#38bdf8,#6366f1); }
  .t-rose  { background:linear-gradient(135deg,#fb7185,#ec4899); }
  .t-mint  { background:linear-gradient(135deg,#34d399,#0891b2); }

  /* tile extras: a themed illustration + a famous quote in each tile's empty zones */
  .heroimg { position:absolute; width:clamp(140px,17vw,290px); height:auto; opacity:.95; z-index:1; }
  .quote { position:absolute; max-width:44%; z-index:2; color:#fff; }
  .quote .q { font-style:italic; font-weight:800; font-size:clamp(.96rem,2vmin,1.5rem); line-height:1.3; }
  .quote .a { font-size:clamp(.7rem,1.35vmin,.9rem); opacity:.88; margin-top:8px; }
  /* image sits toward the centre (clear of the card); quote fills the outer area */
  .tl .heroimg { top:28%;    right:11%; }
  .tl .quote   { left:clamp(22px,4vmin,60px);  bottom:9%; text-align:left; }
  .tr .heroimg { top:28%;    left:11%; }
  .tr .quote   { right:clamp(22px,4vmin,60px); bottom:9%; text-align:right; }
  .bl .heroimg { bottom:28%; right:11%; }
  .bl .quote   { left:clamp(22px,4vmin,60px);  top:9%;    text-align:left; }
  .br .heroimg { bottom:28%; left:11%; }
  .br .quote   { right:clamp(22px,4vmin,60px); top:9%;    text-align:right; }

  /* centred floating card, overlapping all four tiles */
  .center { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10;
            background:#fff; color:var(--ink); border-radius:22px; text-align:center;
            padding:clamp(18px,2.8vmin,40px); width:clamp(380px,42vw,820px);
            box-shadow:0 28px 70px rgba(2,6,23,.4); }
  .center .brand { font-size:clamp(1.2rem,2.4vmin,1.7rem); font-weight:800;
                   display:flex; align-items:center; justify-content:center; gap:8px; color:#4f46e5; }
  .center .brand .brandlogo { width:clamp(34px,4.4vmin,46px); height:clamp(34px,4.4vmin,46px); }
  .center .brand b { color:#dc2626; }
  .center .tag { color:var(--muted); font-size:clamp(.76rem,1.45vmin,.92rem); line-height:1.45;
                 margin:6px 0 14px; }
  .center img { width:clamp(150px,21vmin,220px); height:clamp(150px,21vmin,220px); border-radius:10px; }
  .cta { font-weight:700; font-size:clamp(1.02rem,2.1vmin,1.28rem); margin-bottom:14px; }
  .btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; font-weight:700;
         padding:15px 32px; border-radius:13px; font-size:clamp(.95rem,1.9vmin,1.12rem);
         box-shadow:0 10px 24px rgba(79,70,229,.4); }
  .steps { text-align:left; color:var(--muted); font-size:clamp(.74rem,1.45vmin,.9rem); line-height:1.7; margin-top:12px; }
  .steps b { color:var(--ink); }
  .status { font-size:clamp(.9rem,1.8vmin,1.05rem); color:var(--muted); line-height:1.6; padding:clamp(12px,2vmin,22px) 4px; }

  /* "link a different account" confirmation popup (shown when already connected) */
  .modal-overlay { display:none; position:fixed; inset:0; background:rgba(2,6,23,.55); z-index:50;
                   align-items:center; justify-content:center; padding:20px; }
  .modal { background:#fff; border-radius:16px; padding:26px 24px; max-width:430px; width:100%;
           box-shadow:0 28px 70px rgba(2,6,23,.4); text-align:center; }
  .modal-msg { font-size:1rem; line-height:1.55; color:var(--ink); margin-bottom:18px; }
  .modal-actions { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  .modal .btn { padding:12px 20px; font-size:.95rem; box-shadow:none; }
  .modal .btn-ghost { background:#f1f5f9; color:#475569; }

  /* ---- mobile / narrow portrait: the floating-card-over-2x2-grid can't fit a
     phone, so stack into a scrolling column of rounded CARDS (each tile gets a
     border/shadow like the FactRadar card). FactRadar sits in the MIDDLE of the
     stack — two tiles above, two below — mirroring the desktop centre. */
  @media (max-width: 820px) {
    html, body { height:auto; overflow-x:hidden; overflow-y:auto; }
    body { background:#eef1f6; }
    .wrap { display:flex; flex-direction:column; height:auto; width:100%;
            gap:14px; padding:16px 14px; }
    /* order the column: tile, tile, FactRadar (middle), tile, tile */
    .t-amber { order:1; } .t-sky { order:2; }
    .center  { order:3; }
    .t-rose  { order:4; } .t-mint { order:5; }
    /* every tile becomes a self-contained rounded card; tight, consistent
       left-aligned spacing so the contents don't look scattered */
    .tile { min-height:auto; padding:22px 22px 24px; gap:9px; border-radius:20px;
            box-shadow:0 10px 26px rgba(2,6,23,.16);
            align-items:flex-start !important; justify-content:flex-start !important; text-align:left !important; }
    /* explicit square keeps the inline SVG from reserving a tall box (the cause
       of the big gap between icon and title); line-height:0 trims inline space */
    .tile .art { line-height:0; margin-bottom:2px; }
    .tile .art svg { width:42px; height:42px; }
    .tile h3 { font-size:1.22rem; margin:0; }
    .tile p { font-size:.95rem; max-width:none; opacity:1; margin:0; }
    .tile .more { font-size:.86rem; align-self:flex-start; margin:2px 0 0; }
    /* decorative line-art overlaps badly when stacked — drop it on mobile */
    .heroimg { display:none; }
    /* quotes flow at the end of each card instead of floating in a corner */
    .quote { position:static; max-width:none; margin-top:6px; text-align:left !important; }
    .quote .q { font-size:1.04rem; }
    .quote .a { font-size:.8rem; }
    /* the FactRadar card matches the tile cards' spacing */
    .center { position:static; transform:none; width:auto; margin:0;
              padding:26px 22px; border-radius:20px; box-shadow:0 12px 30px rgba(2,6,23,.2); }
    .center .brand { font-size:1.5rem; }
    .center .tag { font-size:.92rem; }
    .center img { width:210px; height:210px; }
    .cta { font-size:1.18rem; }
    .btn { padding:14px 30px; font-size:1.04rem; }
    .steps { font-size:.88rem; }
  }
</style>
</head>
<body>
${siteHeader()}
<div class="wrap">

  <div class="tile t-amber tl">
    <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v17"/><path d="M8 20h8"/><path d="M4 7h16"/><circle cx="12" cy="5" r="1"/><path d="M4 7l-2 5h4z"/><path d="M2 12a2 2 0 0 0 4 0"/><path d="M20 7l-2 5h4z"/><path d="M18 12a2 2 0 0 0 4 0"/></svg></div>
    <h3>Democracy &amp; the courts</h3>
    <p>Elections and justice depend on a public that knows what is real. Unchecked lies corrode both.</p>
    <span class="more">Lies spread 6\u{00D7} faster than truth</span>
    <svg class="heroimg" viewBox="0 0 100 74" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="50" y1="2" x2="50" y2="6"/>
      <path d="M50 6c-6 0-10 5-10 10h20c0-5-4-10-10-10z"/>
      <rect x="34" y="16" width="32" height="4"/>
      <path d="M20 32 50 20 80 32 Z"/>
      <line x1="20" y1="36" x2="80" y2="36"/>
      <line x1="26" y1="36" x2="26" y2="58"/><line x1="38" y1="36" x2="38" y2="58"/><line x1="50" y1="36" x2="50" y2="58"/><line x1="62" y1="36" x2="62" y2="58"/><line x1="74" y1="36" x2="74" y2="58"/>
      <line x1="18" y1="58" x2="82" y2="58"/>
      <line x1="14" y1="64" x2="86" y2="64"/>
      <line x1="10" y1="70" x2="90" y2="70"/>
    </svg>
    <div class="quote">
      <div class="q">&ldquo;A lie can travel halfway around the world before the truth has got its boots on.&rdquo;</div>
      <div class="a">— and when voters believe lies, democracy makes the wrong choice</div>
    </div>
  </div>

  <div class="tile t-sky tr">
    <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/><circle cx="16" cy="16" r="1.4"/></svg></div>
    <h3>The constitution &amp; rights</h3>
    <p>An informed citizenry is the first defence of every right. People can't protect what they're misled about.</p>
    <span class="more">Know your rights to defend them</span>
    <svg class="heroimg" viewBox="0 0 100 80" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="22" y="8" width="56" height="64" rx="3"/>
      <line x1="32" y1="22" x2="68" y2="22"/><line x1="32" y1="32" x2="68" y2="32"/><line x1="32" y1="42" x2="68" y2="42"/><line x1="32" y1="52" x2="54" y2="52"/>
      <circle cx="62" cy="60" r="7"/>
    </svg>
    <div class="quote">
      <div class="q">&ldquo;Knowledge will forever govern ignorance.&rdquo;</div>
      <div class="a">— James Madison · misinformed people can't guard their own rights</div>
    </div>
  </div>

  <div class="tile t-rose bl">
    <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 7a7 7 0 0 1 0 10"/></svg></div>
    <h3>Media owned by the wealthy</h3>
    <p>A few billionaires shape what most people see as "news". Fact-checks hand power back to ordinary people.</p>
    <span class="more">A few owners, millions of feeds</span>
    <svg class="heroimg" viewBox="0 0 100 80" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="12" y="16" width="66" height="54" rx="2"/>
      <path d="M78 26h10v40a4 4 0 0 1-4 4h-6"/>
      <line x1="20" y1="26" x2="58" y2="26" stroke-width="4"/>
      <rect x="20" y="34" width="22" height="16"/>
      <line x1="48" y1="36" x2="70" y2="36"/><line x1="48" y1="42" x2="70" y2="42"/><line x1="48" y1="48" x2="70" y2="48"/>
      <line x1="20" y1="58" x2="70" y2="58"/><line x1="20" y1="64" x2="58" y2="64"/>
    </svg>
    <div class="quote">
      <div class="q">&ldquo;Whoever controls the media controls the mind.&rdquo;</div>
      <div class="a">— fact-checks hand that power back to ordinary people</div>
    </div>
  </div>

  <div class="tile t-mint br">
    <div class="art"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10c.8.8 1 1.6 1 2.5h6c0-.9.2-1.7 1-2.5a6 6 0 0 0-4-10z"/></svg></div>
    <h3>Truth shouldn't be a luxury</h3>
    <p>Fake cures and scams hit hardest where resources are fewest. Reliable information belongs to everyone.</p>
    <span class="more">The truth should be free for all</span>
    <svg class="heroimg" viewBox="0 0 100 72" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M50 16C40 10 24 10 12 14V58C24 54 40 54 50 60C60 54 76 54 88 58V14C76 10 60 10 50 16Z"/>
      <line x1="50" y1="16" x2="50" y2="60"/>
      <line x1="20" y1="24" x2="42" y2="22"/><line x1="20" y1="32" x2="42" y2="30"/>
      <line x1="58" y1="22" x2="80" y2="24"/><line x1="58" y1="30" x2="80" y2="32"/>
    </svg>
    <div class="quote">
      <div class="q">&ldquo;The truth will set you free — but first it must reach everyone.&rdquo;</div>
      <div class="a">— reliable information is a right, not a luxury</div>
    </div>
  </div>

  <div class="center">
    <div class="brand"><img class="brandlogo" src="/logo.png" alt=""/> Fact<b>Radar</b></div>
    <div class="tag">Checks every image &amp; video shared with you — and tells you what holds up.</div>
    ${centerHtml}
  </div>

</div>
${siteFooter()}
${poll ? `<script>
  var cur=${JSON.stringify(state)};
  setInterval(async()=>{try{const r=await fetch('/status');const j=await r.json();
    if(j.state==='none'){location.href='/';}
    else if(j.state!==cur){location.reload();} // state changed (init->qr, qr->open): re-render
  }catch(e){}},3000);
</script>` : ""}
</body>
</html>`;
}

function termsPage({ consent = false, another = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_TAGS}
<title>FactRadar — Terms of Use &amp; Consent</title>
<style>
  :root { --accent:#4f46e5; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body { font-family:'Segoe UI', system-ui, -apple-system, sans-serif; color:#1e293b;
         height:100vh; display:flex; flex-direction:column; }
${CHROME_CSS}
  /* gradient content area between the thin header + footer (page stays one screen) */
  .terms-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
                background:linear-gradient(155deg,#4f46e5,#7c3aed 55%,#0891b2);
                padding:clamp(12px,2.2vmin,24px); gap:clamp(10px,1.6vmin,16px); }
  .head { color:#fff; text-align:center; flex:0 0 auto; }
  .head .brand { font-weight:700; font-size:clamp(1rem,2vmin,1.35rem); }
  .head .brand b { color:#a5f3fc; }
  .head h1 { font-size:clamp(1.2rem,2.6vmin,1.9rem); font-weight:800; margin-top:4px; }
  .head p { color:#e6e9ff; font-size:clamp(.78rem,1.5vmin,.95rem); margin-top:4px; }
  .panel { background:#fff; border-radius:16px; flex:1 1 auto; min-height:0; display:flex;
           flex-direction:column; box-shadow:0 18px 50px rgba(15,23,42,.3); overflow:hidden; }
  .policy { overflow-y:auto; padding:clamp(16px,2.6vmin,32px); }
  .policy h2 { font-size:1.05rem; margin:18px 0 6px; color:#4f46e5; }
  .policy h2:first-child { margin-top:0; }
  .policy p, .policy li { font-size:.9rem; line-height:1.6; color:#334155; margin-bottom:8px; }
  .policy ul { padding-left:20px; }
  .edu { background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; padding:14px 16px;
         font-size:.9rem; line-height:1.6; color:#3730a3; margin-bottom:14px; }
  .bar { flex:0 0 auto; border-top:1px solid #e8edf5; padding:clamp(12px,2vmin,20px) clamp(16px,2.6vmin,32px);
         display:flex; flex-wrap:wrap; align-items:center; gap:14px; justify-content:space-between; }
  .agree { display:flex; align-items:flex-start; gap:10px; font-size:.88rem; color:#334155; max-width:60%; }
  .agree input { margin-top:3px; width:18px; height:18px; flex:0 0 auto; }
  .actions { display:flex; gap:10px; }
  .btn { border:0; cursor:pointer; font-weight:700; padding:13px 26px; border-radius:11px;
         font-size:.98rem; text-decoration:none; }
  .btn-primary { background:#4f46e5; color:#fff; box-shadow:0 8px 20px rgba(79,70,229,.35); }
  .btn-primary:disabled { background:#c7cbe6; cursor:not-allowed; box-shadow:none; }
  .btn-ghost { background:#f1f5f9; color:#475569; }
  /* mobile: let the consent bar stack so the checkbox text + buttons aren't squeezed */
  @media (max-width: 640px) {
    .bar { flex-direction:column; align-items:stretch; gap:12px; }
    .agree { max-width:none; }
    .actions { justify-content:space-between; }
    .btn { padding:13px 20px; }
  }
</style>
</head>
<body>
${siteHeader()}
<div class="terms-body">
  <div class="head">
    <div class="brand">\u{1F50E} Fact<b>Radar</b></div>
    <h1>Terms of Use, Disclaimer &amp; Consent</h1>
    <p>${consent
        ? "Please read carefully. You must agree before linking a WhatsApp account."
        : "Our Terms of Use, Disclaimer and Privacy notice."} Version ${TERMS_VERSION}.</p>
  </div>

  <div class="panel">
    <div class="policy">
      <div class="edu"><b>Educational &amp; research project.</b> FactRadar is a non-commercial
        project created and provided strictly for <b>educational, research and demonstration
        purposes</b>. It is an experiment in automated misinformation detection, not a
        professional, certified, or commercial fact-checking service, and it is offered free
        of charge with no guarantees of any kind.</div>

      <h2>1. Acceptance of these Terms</h2>
      <p>By ticking the box and linking a WhatsApp account, you ("you", "the User") confirm
        that you have read, understood and agree to be legally bound by these Terms of Use,
        the Disclaimer and the Privacy notice below (together, the "Terms"). If you do not
        agree, do not use FactRadar.</p>

      <h2>2. Eligibility</h2>
      <p>You must be at least 18 years old and have the legal capacity to enter into these
        Terms. By using FactRadar you confirm that you meet these requirements.</p>

      <h2>3. What FactRadar does</h2>
      <p>FactRadar links to your own WhatsApp account as a companion device, reads the images
        and videos shared in chats that account participates in, attempts to extract and check
        factual claims using automated tools and third-party AI services, and sends an automated
        verdict to your own "Message Yourself" chat. Verdicts are generated by software and may
        be incomplete, outdated, or wrong.</p>

      <h2>4. Account ownership — your responsibility</h2>
      <p>You represent, warrant and agree that:</p>
      <ul>
        <li>you are the lawful owner of, or are expressly authorised to control, the WhatsApp
          account and phone number you link;</li>
        <li>you will <b>only</b> link an account and device that belong to you;</li>
        <li>you will <b>not</b> use FactRadar to access, monitor, surveil or intercept the
          account, device, messages or communications of any other person;</li>
        <li>you have obtained any consent required from other participants in your chats for
          their content to be processed.</li>
      </ul>
      <p>Linking or monitoring an account or device you do not own is strictly prohibited and
        may be a criminal offence. <b>You alone are responsible for how you use FactRadar and
        whose account you link.</b> The creator, owner and operator of FactRadar (the
        "Operator") is not responsible for, and accepts no liability arising from, your use of
        any device or account that is not your own, or any use that breaches these Terms or any
        applicable law.</p>

      <h2>5. Relationship with WhatsApp / Meta</h2>
      <p>FactRadar is an independent project and is <b>not affiliated with, endorsed by, or
        connected to</b> WhatsApp LLC, Meta Platforms, Inc., or any of their affiliates.
        Connecting automated tools to WhatsApp may breach WhatsApp's Terms of Service and could
        result in your account being restricted or banned. <b>You accept this risk entirely.</b>
        The Operator is not liable for any suspension, ban, loss of access, or other consequence
        affecting your WhatsApp account. Use of a spare/secondary number is strongly recommended.</p>

      <h2>6. No professional advice; accuracy disclaimer</h2>
      <p>Verdicts and information from FactRadar are automated, provided for general
        informational and educational purposes only, and are <b>not</b> professional, legal,
        medical, financial, journalistic or any other form of advice. They may contain errors
        or omissions. Do not rely on FactRadar to make any decision. Always verify important
        matters with qualified professionals and authoritative primary sources.</p>

      <h2 id="privacy">7. Privacy &amp; data processing</h2>
      <p>To operate, FactRadar processes message content (including images and videos) from the
        chats your linked account participates in, and transmits extracted text and media to
        third-party services (including AI and web-search providers) to generate verdicts.
        Authentication data for your linked session is stored to keep you connected. By using
        FactRadar you consent to this processing. You are responsible for ensuring you have a
        lawful basis to process the content of third parties in your chats. You may unlink and
        request deletion of your session at any time via the unlink option.</p>

      <h2>8. Acceptable use</h2>
      <p>You agree not to use FactRadar to: break any law or regulation; infringe anyone's
        privacy, data-protection, or other rights; stalk, harass, surveil or harm any person;
        process content you have no right to process; or attempt to disrupt, overload, reverse
        engineer or misuse the service. The Operator may suspend or terminate access at any
        time, for any reason, without notice.</p>

      <h2>9. "As is" — no warranties</h2>
      <p>FactRadar is provided <b>"as is" and "as available", with all faults and without
        warranties of any kind</b>, express or implied, including (without limitation) fitness
        for a particular purpose, accuracy, reliability, availability, or non-infringement, to
        the fullest extent permitted by law.</p>

      <h2>10. Limitation of liability</h2>
      <p>To the fullest extent permitted by law, the Operator shall <b>not be liable</b> for any
        direct, indirect, incidental, special, consequential, exemplary or punitive damages, or
        for any loss of data, profits, goodwill, accounts, or other intangible losses, arising
        out of or relating to your use of (or inability to use) FactRadar, any reliance on its
        verdicts, any WhatsApp account action, or any act of any user — whether based in
        contract, tort, negligence, strict liability or otherwise, and even if advised of the
        possibility of such damages. Nothing in these Terms excludes liability that cannot
        lawfully be excluded (such as for death or personal injury caused by negligence, or
        fraud).</p>

      <h2>11. Indemnification</h2>
      <p>You agree to <b>indemnify, defend and hold harmless</b> the Operator and its creators,
        contributors and affiliates from and against any and all claims, demands, liabilities,
        damages, losses, costs and expenses (including reasonable legal fees) arising out of or
        connected with: (a) your use or misuse of FactRadar; (b) your linking or monitoring of
        any account or device you do not own; (c) your breach of these Terms; or (d) your
        violation of any law or the rights of any third party.</p>

      <h2>12. Changes &amp; termination</h2>
      <p>The Operator may modify, suspend or discontinue FactRadar, or update these Terms, at any
        time. Continued use after changes constitutes acceptance. You may stop using FactRadar
        and unlink your account at any time.</p>

      <h2>13. Governing law</h2>
      <p>These Terms are governed by the laws of England and Wales, and the courts of England and
        Wales shall have exclusive jurisdiction, without prejudice to any mandatory consumer
        protections available to you in your country of residence.</p>

      <h2>14. Severability</h2>
      <p>If any provision of these Terms is held to be invalid or unenforceable, the remaining
        provisions shall continue in full force and effect.</p>
    </div>

    ${consent ? `<form class="bar" method="POST" action="/agree">
      ${another ? '<input type="hidden" name="another" value="yes"/>' : ""}
      <label class="agree">
        <input type="checkbox" name="agree" value="yes" required
               onchange="document.getElementById('go').disabled=!this.checked"/>
        <span>I have read and agree to the Terms of Use, Disclaimer and Privacy notice. I confirm
          I will only link a WhatsApp account that I own, and I accept all risks (including a
          possible WhatsApp ban). I understand this is an educational project provided with no
          warranties.</span>
      </label>
      <div class="actions">
        <a class="btn btn-ghost" href="/">Decline</a>
        <button id="go" class="btn btn-primary" type="submit" disabled>Agree &amp; continue &rarr;</button>
      </div>
    </form>` : `<div class="bar">
      <span class="agree" style="align-items:center">You're reading these terms for information. To link a WhatsApp account you'll be asked to accept them.</span>
      <div class="actions">
        <a class="btn btn-ghost" href="/">Back to home</a>
        <a class="btn btn-primary" href="/terms?consent=1">Protect My WhatsApp &rarr;</a>
      </div>
    </div>`}
  </div>
</div>
${siteFooter()}
</body>
</html>`;
}

function unlinkPage(connected) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_TAGS}
<title>FactRadar — Unlink your account</title>
<style>
  :root { --accent:#4f46e5; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body { font-family:'Segoe UI', system-ui, -apple-system, sans-serif; color:#1e293b;
         height:100vh; display:flex; flex-direction:column; }
${CHROME_CSS}
  .ul-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; align-items:center;
             justify-content:center; background:linear-gradient(155deg,#4f46e5,#7c3aed 55%,#0891b2);
             padding:clamp(14px,3vmin,30px); }
  .panel { background:#fff; border-radius:16px; width:min(620px,100%); max-height:100%; overflow-y:auto;
           padding:clamp(22px,3vmin,36px); box-shadow:0 18px 50px rgba(15,23,42,.3); }
  .panel h1 { font-size:clamp(1.25rem,2.6vmin,1.7rem); margin-bottom:6px; }
  .panel .sub { color:#64748b; font-size:.92rem; margin-bottom:18px; }
  ol.steps { margin:0 0 8px 0; padding-left:22px; }
  ol.steps li { font-size:.95rem; line-height:1.6; color:#334155; margin-bottom:12px; }
  ol.steps b { color:#1e293b; }
  .bar { display:flex; flex-wrap:wrap; gap:12px; justify-content:flex-end; margin-top:18px;
         border-top:1px solid #e8edf5; padding-top:18px; }
  .btn { border:0; cursor:pointer; font-weight:700; padding:13px 24px; border-radius:11px; font-size:.98rem;
         text-decoration:none; display:inline-block; }
  .btn-ghost { background:#f1f5f9; color:#475569; }
  .btn-danger { background:#dc2626; color:#fff; box-shadow:0 8px 20px rgba(220,38,38,.32); }
  .note { background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; padding:12px 14px;
          font-size:.9rem; color:#3730a3; margin-bottom:16px; }
</style>
</head>
<body>
${siteHeader()}
<div class="ul-body">
  <div class="panel">
    <h1>Unlink your WhatsApp account</h1>
    <div class="sub">Here's exactly what happens, and how to remove FactRadar completely.</div>
    ${connected ? "" : `<div class="note">This browser doesn't currently have an active linked account — there may be nothing to unlink here.</div>`}
    <ol class="steps">
      <li><b>Confirm below.</b> FactRadar immediately stops watching this account and
        <b>deletes its saved login session</b> from our server.</li>
      <li><b>Remove it inside WhatsApp too (recommended).</b> Open WhatsApp on your phone →
        <b>Settings &rarr; Linked devices</b> → tap the <b>FactRadar / Chrome</b> entry → <b>Log out</b>.
        This fully revokes access.</li>
      <li><b>Your data.</b> We stop processing new messages for this account right away. No further
        verdicts will be generated.</li>
      <li><b>Changed your mind?</b> You can re-link any time from the home page by accepting the
        Terms and scanning a fresh QR code.</li>
    </ol>
    <form class="bar" method="POST" action="/unlink">
      <a class="btn btn-ghost" href="/">Cancel</a>
      <button class="btn btn-danger" type="submit">Confirm unlink</button>
    </form>
  </div>
</div>
${siteFooter()}
</body>
</html>`;
}

// ---- boot: resume previously-linked sessions, then serve ------------------
const resumeSids = readdirSync(AUTH_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
for (const sid of resumeSids) {
  startSession(sid).catch((e) => logger.error({ sid }, e, "resume failed"));
}
// Keep the registry honest: any device the DB still marks linked/linking but that
// has no auth folder to resume is a discontinued session — mark it unlinked so the
// admin only ever shows genuinely-active devices.
reconcileLinked(resumeSids);

app.listen(PORT, () => logger.info(`ingest control surface on :${PORT}`));
