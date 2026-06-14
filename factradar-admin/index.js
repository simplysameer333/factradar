// factradar-admin — authenticated admin console for FactRadar.
//
// Separate service from the public link flow (factradar-ingest, which stays
// open/no-auth). EVERYTHING here is behind an admin login. It connects to the
// shared MongoDB audit store and provides:
//   - a dashboard: device registry + lifecycle/audit trail + check stats
//   - JSON APIs for the same data
//   - approve / reject link requests (decision is recorded now; ingest will
//     enforce it later — see APPROVAL note below)
//
// Auth model: a single shared ADMIN_PASSWORD. POST /login checks it with a
// constant-time compare and sets a stateless httpOnly cookie (an HMAC of the
// password); every other route requires that cookie.

import express from "express";
import crypto from "node:crypto";
import pino from "pino";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listDevices,
  getDevice,
  listEvents,
  overview,
  dailyChecks,
  setApproval,
} from "./db.js";

const PORT = process.env.PORT || 41900;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// Public website URL — the admin pages link back here ("Back to FactRadar").
const SITE_URL = process.env.SITE_URL || "http://localhost:41734";
const log = pino({ level: process.env.LOG_LEVEL || "info" });

if (!ADMIN_PASSWORD) {
  log.error("ADMIN_PASSWORD is not set — refusing to start an unprotected admin console");
  process.exit(1);
}

// Stateless session token = HMAC(password, "factradar-admin"). Knowing the
// cookie value requires knowing the password; no server-side session store.
const COOKIE = "fr_admin";
const TOKEN = crypto.createHmac("sha256", ADMIN_PASSWORD).update("factradar-admin").digest("hex");

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getCookie(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(join(__dirname, "public"))); // /logo.png, /favicon.png (public, pre-auth)

// ---- auth -----------------------------------------------------------------

function requireAuth(req, res, next) {
  const tok = getCookie(req, COOKIE);
  if (tok && timingSafeEqual(tok, TOKEN)) return next();
  // APIs get 401 JSON; pages get redirected to the login screen.
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  return res.redirect("/login");
}

app.get("/login", (req, res) => res.send(loginPage(req.query.error === "1")));

app.post("/login", (req, res) => {
  if (!timingSafeEqual(req.body.password || "", ADMIN_PASSWORD)) {
    log.warn({ ip: req.ip }, "failed admin login");
    return res.redirect("/login?error=1");
  }
  res.cookie(COOKIE, TOKEN, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12, // 12h
  });
  log.info({ ip: req.ip }, "admin login");
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.redirect("/login");
});

// Everything below requires auth.
app.use(requireAuth);

// ---- JSON API -------------------------------------------------------------

app.get("/api/overview", async (_req, res) => res.json(await overview()));

app.get("/api/devices", async (req, res) =>
  res.json(await listDevices({ status: req.query.status || null }))
);

app.get("/api/devices/:sid", async (req, res) => {
  const device = await getDevice(req.params.sid);
  if (!device) return res.status(404).json({ error: "not found" });
  const events = await listEvents({ sid: req.params.sid, limit: 200 });
  res.json({ device, events });
});

app.get("/api/events", async (req, res) =>
  res.json(await listEvents({ sid: req.query.sid, type: req.query.type, limit: Number(req.query.limit) || 200 }))
);

app.get("/api/daily", async (req, res) => res.json(await dailyChecks(Number(req.query.days) || 30)));

// Approve / reject a link request (decision recorded now; enforced later).
app.post("/api/devices/:sid/approve", async (req, res) =>
  res.json(await setApproval(req.params.sid, true))
);
app.post("/api/devices/:sid/reject", async (req, res) =>
  res.json(await setApproval(req.params.sid, false))
);

// ---- dashboard (server-rendered shell + small client for live data) -------

app.get("/", async (_req, res) => res.send(dashboardPage()));

app.get("/devices/:sid", async (req, res) => {
  const device = await getDevice(req.params.sid);
  if (!device) return res.status(404).send(shell("Not found", "<p>No such device.</p>"));
  const events = await listEvents({ sid: req.params.sid, limit: 200 });
  res.send(devicePage(device, events));
});

// ---- HTML -----------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const STYLE = `
  :root { --ink:#1e293b; --muted:#64748b; --accent:#4f46e5; --line:#e2e8f0; --bg:#f8fafc; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:'Segoe UI',system-ui,sans-serif; color:var(--ink); background:var(--bg);
         display:flex; flex-direction:column; min-height:100vh; }
  /* thin LIGHT top bar (so the logo's green radar is visible) */
  header.site-header { background:#ffffff; color:var(--ink); height:50px; padding:0 22px;
           display:flex; align-items:center; gap:12px; flex:0 0 auto;
           border-bottom:1px solid var(--line); box-shadow:0 1px 8px rgba(2,6,23,.05); }
  header.site-header .lock { display:flex; align-items:center; gap:9px; text-decoration:none; color:var(--ink); }
  header.site-header .lock img { width:34px; height:34px; display:block; }
  header.site-header .brand { font-weight:800; font-size:1.05rem; color:#4f46e5; }
  header.site-header .brand b { color:#dc2626; }
  header.site-header .sp { flex:1; }
  header.site-header a.nav { color:var(--muted); text-decoration:none; font-size:.88rem; font-weight:600; }
  header.site-header a.nav:hover { color:var(--ink); }
  main { padding:22px; max-width:1200px; margin:0 auto; width:100%; flex:1 0 auto; }
  /* thin LIGHT bottom bar */
  footer.site-footer { background:#f6f8fb; color:var(--muted); min-height:42px; padding:8px 22px; flex:0 0 auto;
           display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:6px 16px; font-size:.78rem;
           border-top:1px solid var(--line); }
  footer.site-footer a { color:#475569; text-decoration:none; }
  footer.site-footer a:hover { color:var(--accent); }
  footer.site-footer .fl { display:flex; gap:14px; flex-wrap:wrap; }
  h1 { font-size:1.3rem; margin:0 0 16px; }
  h2 { font-size:1.05rem; margin:26px 0 10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; }
  .card .n { font-size:1.8rem; font-weight:800; }
  .card .l { color:var(--muted); font-size:.82rem; margin-top:4px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line);
          border-radius:12px; overflow:hidden; font-size:.86rem; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); }
  th { background:#f1f5f9; font-weight:700; color:#475569; }
  tr:last-child td { border-bottom:0; }
  td a { color:var(--accent); text-decoration:none; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:.74rem; font-weight:700; }
  .s-linked { background:#dcfce7; color:#166534; }
  .s-linking { background:#fef9c3; color:#854d0e; }
  .s-unlinked { background:#fee2e2; color:#991b1b; }
  .s-abandoned { background:#e2e8f0; color:#475569; }
  .a-approved { background:#dbeafe; color:#1e40af; }
  .a-rejected { background:#fee2e2; color:#991b1b; }
  .a-pending { background:#f1f5f9; color:#64748b; }
  .btn { border:0; cursor:pointer; font-weight:600; padding:6px 12px; border-radius:8px; font-size:.8rem; }
  .btn-ok { background:#16a34a; color:#fff; }
  .btn-no { background:#dc2626; color:#fff; }
  .muted { color:var(--muted); }
  code { background:#f1f5f9; padding:1px 6px; border-radius:5px; font-size:.82rem; }
`;

const ADMIN_FOOTER = `<footer class="site-footer">
  <div class="fl"><a href="/">Dashboard</a><a href="/logout">Log out</a><a href="${SITE_URL}">FactRadar website</a></div>
  <div>© 2026 FactRadar · Admin console · Educational project</div></footer>`;

function shell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<title>FactRadar Admin — ${esc(title)}</title><style>${STYLE}</style></head>
<body><header class="site-header">
  <a class="lock" href="/"><img src="/logo.png" alt="FactRadar logo"/><span class="brand">Fact<b>Radar</b> · Admin</span></a>
  <span class="sp"></span><a class="nav" href="/">Dashboard</a><a class="nav" href="/logout">Log out</a></header>
<main>${body}</main>
${ADMIN_FOOTER}</body></html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<title>FactRadar Admin — Sign in</title><style>${STYLE}
  .login { max-width:360px; margin:auto; background:#fff; border:1px solid var(--line);
           border-radius:16px; padding:30px; }
  .login h1 { text-align:center; display:flex; align-items:center; justify-content:center; gap:10px; }
  .login h1 img { width:40px; height:40px; }
  .login input { width:100%; padding:12px; border:1px solid var(--line); border-radius:9px; font-size:1rem; margin:8px 0 14px; }
  .login .btn-primary { width:100%; background:var(--accent); color:#fff; padding:12px; font-size:1rem; }
  .login .back { text-align:center; margin-top:16px; }
  .login .back a { color:var(--accent); text-decoration:none; font-size:.88rem; font-weight:600; }
  .login .back a:hover { text-decoration:underline; }
  .err { color:#dc2626; font-size:.85rem; text-align:center; margin-bottom:8px; }
</style></head><body>
  <header class="site-header">
    <a class="lock" href="/login"><img src="/logo.png" alt="FactRadar logo"/><span class="brand">Fact<b>Radar</b> · Admin</span></a>
    <span class="sp"></span><a class="nav" href="${SITE_URL}">&larr; Back to FactRadar</a>
  </header>
  <main style="display:flex; align-items:center;">
    <div class="login">
      <h1><img src="/logo.png" alt=""/> FactRadar Admin</h1>
      ${error ? '<div class="err">Incorrect password.</div>' : ""}
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Admin password" autofocus required/>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
      <div class="back"><a href="${SITE_URL}">&larr; Back to FactRadar website</a></div>
    </div>
  </main>
  ${ADMIN_FOOTER}</body></html>`;
}

function dashboardPage() {
  // Server shell + a small client that pulls live JSON so the page stays current.
  return shell(
    "Dashboard",
    `<h1>Overview</h1>
     <div class="cards" id="cards"><div class="card"><div class="n muted">…</div></div></div>

     <h2>Active devices</h2>
     <div style="margin-bottom:8px">
       <label class="muted" style="font-size:.85rem">Show:
         <select id="statusFilter">
           <option value="linked" selected>active (linked)</option>
           <option value="">all (incl. history)</option>
           <option value="linking">linking</option>
           <option value="unlinked">unlinked</option>
           <option value="rejected_duplicate">rejected duplicates</option>
           <option value="abandoned">abandoned</option>
           <option value="orphaned">orphaned</option>
         </select></label>
     </div>
     <table id="devices"><thead><tr>
       <th>Phone</th><th>Status</th><th>Approval</th><th>Checks</th><th>Msgs</th>
       <th>Linked</th><th>Last seen</th><th>Actions</th></tr></thead>
       <tbody><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table>

     <h2>Recent activity</h2>
     <table id="events"><thead><tr><th>Time</th><th>Service</th><th>Event</th><th>Phone / Session</th><th>Detail</th></tr></thead>
       <tbody><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>

     <script>
     const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
     const fmt = t => t ? new Date(t).toLocaleString() : "—";
     const statusPill = s => '<span class="pill s-'+esc(s||'unknown')+'">'+esc(s||'unknown')+'</span>';
     const apprPill = a => { const k = a==='approved'?'approved':a==='rejected'?'rejected':'pending';
       return '<span class="pill a-'+k+'">'+k+'</span>'; };

     async function loadOverview(){
       const o = await (await fetch('/api/overview')).json();
       const s = o.status || {};
       document.getElementById('cards').innerHTML = [
         ['Devices', o.totalDevices],
         ['Linked', s.linked||0],
         ['Checks today', o.checksToday],
         ['Checks total', o.checksTotal],
         ['Rate-limited today', o.rateLimitedToday],
       ].map(([l,n]) => '<div class="card"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>').join('');
     }

     async function act(sid, what){
       await fetch('/api/devices/'+sid+'/'+what, {method:'POST'});
       loadDevices();
     }

     async function loadDevices(){
       const st = document.getElementById('statusFilter').value;
       const rows = await (await fetch('/api/devices'+(st?'?status='+st:''))).json();
       const tb = document.querySelector('#devices tbody');
       if(!rows.length){ tb.innerHTML='<tr><td colspan="8" class="muted">No devices yet.</td></tr>'; return; }
       tb.innerHTML = rows.map(d => {
         const c = (d.counters_checks_total ?? d.checks_total ?? '');
         return '<tr>'+
           '<td><a href="/devices/'+esc(d._id)+'">'+esc(d.phone||'(pending)')+'</a></td>'+
           '<td>'+statusPill(d.status)+'</td>'+
           '<td>'+apprPill(d.approval)+'</td>'+
           '<td>'+(d.checks_total||0)+'</td>'+
           '<td>'+(d.messages_received_total||0)+'</td>'+
           '<td class="muted">'+fmt(d.linkedAt)+'</td>'+
           '<td class="muted">'+fmt(d.lastSeenAt)+'</td>'+
           '<td><button class="btn btn-ok" onclick="act(\\''+d._id+'\\',\\'approve\\')">Approve</button> '+
               '<button class="btn btn-no" onclick="act(\\''+d._id+'\\',\\'reject\\')">Reject</button></td>'+
         '</tr>';
       }).join('');
     }

     async function loadEvents(){
       const rows = await (await fetch('/api/events?limit=60')).json();
       const tb = document.querySelector('#events tbody');
       if(!rows.length){ tb.innerHTML='<tr><td colspan="5" class="muted">No events yet.</td></tr>'; return; }
       tb.innerHTML = rows.map(e =>
         '<tr><td class="muted">'+fmt(e.ts)+'</td><td>'+esc(e.service)+'</td>'+
         '<td><code>'+esc(e.type)+'</code></td>'+
         '<td>'+esc(e.phone || (e.sid? e.sid.slice(0,8)+'…' : '—'))+'</td>'+
         '<td class="muted">'+esc(JSON.stringify(e.detail||{}).slice(0,90))+'</td></tr>'
       ).join('');
     }

     function refresh(){ loadOverview(); loadDevices(); loadEvents(); }
     document.getElementById('statusFilter').addEventListener('change', loadDevices);
     refresh();
     setInterval(refresh, 10000);
     </script>`
  );
}

function devicePage(d, events) {
  const rows = events
    .map(
      (e) =>
        `<tr><td class="muted">${esc(new Date(e.ts).toLocaleString())}</td>
         <td>${esc(e.service)}</td><td><code>${esc(e.type)}</code></td>
         <td class="muted">${esc(JSON.stringify(e.detail || {}))}</td></tr>`
    )
    .join("");
  const consent = d.consent
    ? `accepted ${esc(d.consent.at)} from <code>${esc(d.consent.ip)}</code> (terms ${esc(d.consent.termsVersion)})`
    : "—";
  return shell(
    `Device ${esc(d.phone || d._id)}`,
    `<h1>${esc(d.phone || "(pending)")} <span class="pill s-${esc(d.status || "unknown")}">${esc(d.status || "unknown")}</span></h1>
     <p class="muted">Session <code>${esc(d._id)}</code> · JID <code>${esc(d.jid || "—")}</code></p>
     <div class="cards">
       <div class="card"><div class="n">${d.checks_total || 0}</div><div class="l">Checks</div></div>
       <div class="card"><div class="n">${d.messages_received_total || 0}</div><div class="l">Messages</div></div>
       <div class="card"><div class="n">${d.verdicts_sent_total || 0}</div><div class="l">Verdicts sent</div></div>
       <div class="card"><div class="n">${d.claims_checked_total || 0}</div><div class="l">Claims checked</div></div>
     </div>
     <h2>Lifecycle</h2>
     <p class="muted">Created ${esc(d.createdAt)} · Linked ${esc(d.linkedAt || "—")} ·
       Unlinked ${esc(d.unlinkedAt || "—")} · Last seen ${esc(d.lastSeenAt || "—")}</p>
     <p class="muted">Consent: ${consent}</p>
     <p>Approval: <span class="pill a-${d.approval === "approved" ? "approved" : d.approval === "rejected" ? "rejected" : "pending"}">${esc(d.approval || "pending")}</span>
       &nbsp; <button class="btn btn-ok" onclick="dec('approve')">Approve</button>
       <button class="btn btn-no" onclick="dec('reject')">Reject</button></p>
     <h2>Audit trail</h2>
     <table><thead><tr><th>Time</th><th>Service</th><th>Event</th><th>Detail</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="4" class="muted">No events.</td></tr>'}</tbody></table>
     <script>
       async function dec(w){ await fetch('/api/devices/${esc(d._id)}/'+w,{method:'POST'}); location.reload(); }
     </script>`
  );
}

app.listen(PORT, () => log.info(`admin console on :${PORT}`));
