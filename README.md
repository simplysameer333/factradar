# FactRadar

A **WhatsApp misinformation radar**. Anyone links their **own** WhatsApp account as
a companion device; FactRadar watches the chats/groups that account is in,
fact-checks the **images, videos and links** shared there against the web, and
posts a **graded verdict** privately to that account's own "Message Yourself"
chat. Senders and groups are never notified.

It is a **multi-tenant web service**: a single public site where each visitor links
their own account and gets verdicts in their own self-chat. It ships as three
services plus an authenticated admin console.

> ⚠️ **Educational / research project.** Automating WhatsApp breaches WhatsApp's
> Terms of Service and can get a number banned (higher risk from a datacenter IP).
> Use a **spare number**, keep volume low. It processes third-party message content,
> so you are responsible for a lawful basis to do so. Not legal/medical/financial advice.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
 WhatsApp ──▶ factradar-ingest ──HTTP /ingest──▶ factradar-core    │
   ▲          (Node / Baileys)                   (Python/FastAPI/   │
   │                 ▲                             LangGraph)        │
   └── POST /send ───┘◀──────── verdict ──────────────┘            │
                     │                                              │
                     └───────────┐               ┌─────────────────┘
                                 ▼               ▼
                            MongoDB Atlas  ◀── factradar-admin
                            (audit trail)      (Node/Express, auth'd dashboard)
```

| Service | Stack | Port (default) | Role |
|---|---|---|---|
| **factradar-ingest** | Node 18+ / Baileys / Express | `41734` | Public site + multi-tenant WhatsApp linking, message forwarding, verdict delivery |
| **factradar-core** | Python 3.13 / FastAPI / LangGraph | `41820` | Media → text, link fetching, the fact-check pipeline, rate limiting |
| **factradar-admin** | Node 18+ / Express | `41900` | Authenticated dashboard over the MongoDB audit trail |
| **MongoDB Atlas** | — | — | Shared **audit trail** (devices registry + append-only event log) |

## What it does

- **Media fact-checking** — image OCR (Tesseract), audio/voice-note + video
  transcription (faster-whisper), video-frame OCR (ffmpeg). Plain text is **not**
  checked by default (`PROCESS_TEXT=false`) because chat volume is huge.
- **Any-link fact-checking** — any shared URL is fetched: video sites (YouTube, X,
  Facebook, Instagram, TikTok, 1000+ via yt-dlp) are downloaded + transcribed;
  articles/posts fall back to page text. An SSRF guard blocks private/loopback hosts.
- **Multi-claim, graded verdicts** — each distinct claim is extracted (top 5 by
  importance) and judged separately: `True | False | Misleading | Unverified`,
  each with a confidence score and source links. A confidence gate
  (`CONFIDENCE_GATE`, default 60) demotes low-confidence calls to Unverified.
- **Balanced source-credibility weighting** — a strong source (wire agencies,
  major broadsheets, dedicated fact-checkers, official records) → high-confidence
  verdict; **2+ independent weaker sources** agreeing → moderate-confidence verdict;
  a single content-farm source → Unverified. Includes a fabricated-quote rule
  (a sensational quote no source corroborates → False).
- **Verdicts delivered to the linked account's own self-chat** (`OUTPUT_JID=me`),
  as **two messages** (summary + full reasoning), both **reply-quoting** the
  original item so they're tagged to exactly what was checked. Image/video checks
  re-attach the media with the verdict as caption.
- **Consent gate** — a Terms of Use / Disclaimer / Privacy page must be accepted
  (recorded with timestamp, IP, UA, terms version) before any account can link.
- **Duplicate-device protection** — one WhatsApp account is never linked twice:
  re-linking from the same browser reuses the existing session; a duplicate that
  slips through is auto-logged-out of WhatsApp; the UI shows an "already listed"
  message. (Limitation: keyed to the browser cookie — a different browser can't be
  recognised as the same WhatsApp, an inherent WhatsApp-linking constraint.)
- **MongoDB audit trail** — every lifecycle and check event is recorded (see below).
- **Rate limiting** — per-session (hour + day) and a global daily ceiling protect
  the shared LLM key on a public deploy; per-IP cap on session creation in ingest.

## Audit trail (MongoDB)

Database `factradar`, two collections:

- **`devices`** — one registry doc per session: `status`
  (`linking | linked | unlinked | abandoned | rejected_duplicate | orphaned`),
  `jid`/`phone`, consent record, `linkedAt`/`unlinkedAt`/`lastSeenAt`, and rolling
  counters (`checks_total`, `claims_checked_total`, `messages_received_total`,
  `verdicts_sent_total`).
- **`audit_events`** — append-only log. Ingest writes `consent_accepted`,
  `qr_generated`, `linked`, `reconnected`, `unlinked`, `session_swept`,
  `duplicate_link_rejected`, `message_received`, `verdict_sent`. Core writes
  `check_completed`, `check_skipped`, `check_rate_limited`. Admin writes
  `device_approved` / `device_rejected`.

Audit is **best-effort**: if `MONGODB_URI` is unset or Mongo is unreachable, the
services run normally and audit silently no-ops.

## Run locally

You need **Python 3.13**, **Node 18+**, a **MongoDB** connection string (Atlas free
tier is fine; optional — leave blank to disable audit), and for the default LLM
path either an **OpenAI API key** or a local **Ollama**.

Each service reads its own `.env` (copy from the provided `.env.example`).

### 1. Core (`factradar-core`)
```bash
cd factradar-core
python -m venv .venv
.venv\Scripts\activate            # Windows  (use: source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
copy .env.example .env            # then edit: OPENAI_API_KEY, MONGODB_URI, etc.
.venv\Scripts\uvicorn main:app --port 41820 --env-file .env
```

Media needs two **system binaries** (the pip packages alone aren't enough):

| Need | macOS | Debian/Ubuntu | Windows |
|---|---|---|---|
| Tesseract OCR | `brew install tesseract` | `apt install tesseract-ocr` | `choco install tesseract` / [UB-Mannheim build](https://github.com/UB-Mannheim/tesseract/wiki) |
| ffmpeg (video-frame OCR + yt-dlp) | `brew install ffmpeg` | `apt install ffmpeg` | `choco install ffmpeg` |

If they're not on `PATH`, set `TESSERACT_CMD` / `FFMPEG_CMD` to the full exe path.
Audio/voice-note transcription needs neither (faster-whisper bundles its decoder);
the first transcription downloads the Whisper model (`WHISPER_MODEL`, default `base`).

### 2. Ingest (`factradar-ingest`)
```bash
cd factradar-ingest
copy .env.example .env            # set MONGODB_URI, ADMIN_URL, CORE_URL
npm install
npm start                          # serves on http://localhost:41734
```

### 3. Admin (`factradar-admin`)
```bash
cd factradar-admin
copy .env.example .env            # set ADMIN_PASSWORD (required), MONGODB_URI, SITE_URL
npm install
npm start                          # serves on http://localhost:41900
```

### 4. Link a WhatsApp account
Open **<http://localhost:41734>** → **Protect My WhatsApp** → accept the Terms →
scan the QR in WhatsApp → **Settings → Linked devices → Link a device**. Use a
**spare number**. The whole flow lives on `/` — no path changes. Forward an image,
video, or link to your own "Message Yourself" chat to get a verdict back.

The **admin dashboard** is at **<http://localhost:41900>** (password = `ADMIN_PASSWORD`).

## Environment variables

**factradar-core**

| Var | Purpose |
|---|---|
| `LLM_BACKEND` | `openai` (default in dev) / `ollama` / `claude` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI path (`gpt-4o-mini` recommended) |
| `OLLAMA_MODEL`, `OLLAMA_URL` | free/local path |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Claude **API** (billed separately from Claude.ai) |
| `OUTPUT_JID` | `me` = linked account's self-chat (multi-tenant default) |
| `CONFIDENCE_GATE` | min confidence before a call is demoted to Unverified (default 60) |
| `INGEST_URL` | where core reaches ingest (`/send`) |
| `RATE_PER_SESSION_PER_HOUR/DAY`, `RATE_GLOBAL_PER_DAY` | rate-limit caps |
| `MONGODB_URI`, `MONGODB_DB` | audit store (blank = disabled) |
| `WHISPER_MODEL/DEVICE/COMPUTE`, `VIDEO_OCR_FRAMES`, `TESSERACT_CMD`, `FFMPEG_CMD` | media stage |
| `FACTCHECK_API_KEY` | optional Google Fact Check Tools API key (improves accuracy) |

**factradar-ingest**

| Var | Purpose |
|---|---|
| `PORT` | default 41734 |
| `AUTH_DIR` | Baileys session store — **must be a persistent volume in prod** |
| `CORE_URL` | where ingest reaches core (`/ingest`) |
| `ADMIN_URL` | the admin console URL (header "Admin login" link) |
| `MAX_MEDIA_BYTES`, `PROCESS_TEXT`, `MAX_SESSIONS`, `LINK_PER_IP_PER_HOUR`, `UNLINKED_TTL_MS` | tuning / anti-abuse |
| `MONGODB_URI`, `MONGODB_DB` | audit store |

**factradar-admin**

| Var | Purpose |
|---|---|
| `PORT` | default 41900 |
| `ADMIN_PASSWORD` | **required** — the only thing protecting the console |
| `SITE_URL` | public site URL (admin links back to it) |
| `MONGODB_URI`, `MONGODB_DB` | audit store (shared with core + ingest) |

## Deploy to Railway

Create services from this repo in one project:

| Service | Root | Start |
|---|---|---|
| ingest | `factradar-ingest` | `npm start` |
| core | `factradar-core` | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| admin | `factradar-admin` | `npm start` |

**Critical settings:**
- **Attach a Volume to `ingest`** mounted at `/data`, set `AUTH_DIR=/data/auth` —
  otherwise every redeploy wipes WhatsApp sessions and forces a re-scan.
- Set the cross-service URLs to the **private** addresses: `CORE_URL` (ingest),
  `INGEST_URL` (core); set `ADMIN_URL`/`SITE_URL` to the public URLs.
- Point all three at the same `MONGODB_URI` / `MONGODB_DB`.
- Set a strong `ADMIN_PASSWORD`.
- Keep ingest **always-on** (no scale-to-zero) — it holds persistent sockets.
- **Media:** the core image needs `tesseract-ocr` + `ffmpeg` system packages
  (Dockerfile or nixpacks config) — pip installs don't provide them. Whisper runs
  on CPU; pick ≥2 GB RAM or set `WHISPER_MODEL=tiny`.
- `yt-dlp` on a datacenter IP may be throttled/blocked by YouTube/social sites, so
  link-download reliability is worse in prod than locally.

## Roadmap / not yet done

- **Dockerfile** for core bundling tesseract + ffmpeg + yt-dlp; Railway volume wiring.
- **Admin approval queue** — every link request approved by an admin before use
  (approve/reject endpoints + audit events exist; enforcement is not wired yet).
- **Recycled-image detection** (perceptual hashing) and **claim deduplication**.
- **Next.js public dashboard** (verdict feed / review queue) beyond the admin console.
- A **solicitor review** of the self-drafted Terms before any serious public launch.

## Locked decisions

- Hosting: **Railway**, always-on ingest. WhatsApp via **Baileys** companion link,
  the user's **own** number, QR/pairing as proof of ownership.
- **Only the linked account's own chats** are read — never monitor a number you
  don't control (out of scope, permanently).
- Verdicts go to **one** destination; **no** auto-posting into source groups or
  replying to senders in v1.
- LLM is swappable behind one `get_llm()` interface. The Claude **API** is billed
  separately from any Claude.ai subscription.

See `CLAUDE.md` for the full project context and `FactRadar_URD_v1.2.docx` for the
requirements spec.
