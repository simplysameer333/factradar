# FactRadar — Project Context for Claude Code

> A WhatsApp misinformation radar. Links the user's **own** WhatsApp account as a
> companion device, watches the chats/groups that account is in, fact-checks shared
> claims against the web, and posts a graded verdict to **one** private destination.
> Full spec: see `FactRadar_URD_v1.2.docx`. Run/deploy steps: see `README.md`.

## Locked decisions (do not re-litigate)

- **Hosting:** server runs on **Railway** (three services: ingest, core, admin). Not
  serverless; ingest is always-on.
- **WhatsApp access:** companion-device link via **Baileys**, using the user's **own**
  number scanned by **QR** (or pairing code). The QR scan is the proof of ownership.
- **You can only read the linked account's own chats/groups.** Never attempt to monitor
  a number the user doesn't control — that's stalkerware and is out of scope, permanently.
- **Output:** verdicts go to a **single configured destination** (`OUTPUT_JID`, e.g. a
  private log group). **No auto-posting into source groups and no replying to senders in v1.**
  Public/opt-in posting is a deliberate Phase-2 item, gated behind high confidence.
- **Verdicts are graded:** `True | False | Misleading | Unverified`, always with a
  confidence score and source links. Default to **Unverified** when evidence is thin.
  A confidence gate demotes low-confidence calls to Unverified.
- **Human-in-the-loop:** the operator reviews verdicts; the system never acts autonomously
  in public.
- **LLM:** swappable behind one interface. Default **Ollama** (free/local); optional
  **OpenAI API** (`gpt-4o-mini`) or **Anthropic Claude API** (`claude-haiku-4-5-20251001`).
  The Claude **API is billed separately from any Claude.ai subscription** — they are
  not interchangeable.
- **Never** use an LLM free tier that trains on submitted data or excludes UK commercial
  use (rules out the Gemini free tier for this UK project).
- **Operational safety:** use a **spare WhatsApp number**; linking/automating WhatsApp
  breaches its ToS and risks bans (higher from a datacenter IP). Keep outbound volume low.
- **Privacy:** UK-based; processes third-party message content. Keep processing local by
  default, minimise retention, stay within personal/household scope unless addressed.

## Architecture

```
WhatsApp ─▶ factradar-ingest (Node/Baileys) ─HTTP /ingest▶ factradar-core (Python/FastAPI/LangGraph)
   ▲              │                                              │
   └─ /send ◀─────┤  verdict                                     │
                  └──────────▶ MongoDB Atlas ◀──────────────────┘
                              (audit trail)  ▲
                                             └── factradar-admin (Node/Express, auth'd dashboard)
```

Ports: ingest **41734**, core **41820**, admin **41900**.
Pipeline (LangGraph): check-worthiness → claim extraction (top-5 by importance) →
evidence retrieval (DDG web search + Google Fact Check Tools API) → graded verdict
with balanced source-credibility weighting → confidence gate → send (2 reply-quoted
messages to the linked account's own self-chat).

## Stack

- **Python 3.13**, **LangGraph + LangChain**, **FastAPI** — `factradar-core`
- **Node 18+ / Baileys / Express** — `factradar-ingest` (public site + linking)
- **Node 18+ / Express** — `factradar-admin` (authenticated audit dashboard, port 41900)
- **MongoDB Atlas** — shared audit trail (`devices` + `audit_events`); best-effort
- **Ollama** (free) / **OpenAI `gpt-4o-mini`** (dev default — local models too weak for
  claim extraction) / **Claude API** (optional, billed separately)
- **faster-whisper**, **Tesseract**, **ffmpeg**, **yt-dlp** — media + link stage (built)
- **Next.js + Tailwind** — public dashboard (not built; admin console covers ops for now)

## Naming conventions

- Brand: `FactRadar`. Technical: `factradar` (lowercase, no spaces).
- Services: `factradar-ingest`, `factradar-core`, `factradar-admin`, `factradar-ui` (future),
  `factradar-desktop` (future).
- Env prefix: `FACTRADAR_` where applicable. (Working name — renameable globally.)

## Current state (multi-tenant + audit + admin — live-tested 2026-06-13, public on GitHub)

Repo: **github.com/simplysameer333/factradar** (public). End-to-end live-tested:
link → forward media/link → graded verdict in self-chat → audit recorded → visible
in admin dashboard.

- `factradar-ingest/` (`index.js`, `audit.js`) — **multi-tenant** session manager:
  one Baileys socket + auth folder (`AUTH_DIR/<sid>`) per user, keyed by an
  unguessable `fr_sid` cookie. Single public page at `/` (landing → Terms → QR →
  connected, no path changes). `/agree` consent gate records {at, ip, ua, version}.
  `/send` (jid `me` + media + `reply_to`), `/status`, `/unlink` (2-step: steps page
  + POST confirm). `PROCESS_TEXT=false`; self-chat msgs processed despite `fromMe`
  with loop protection. **Duplicate-device protection** (3 layers): /agree reuses the
  browser's on-disk auth folder; on connect, a same-jid duplicate (live OR in DB) is
  logged out of WhatsApp + the browser shown "already listed"; the connected popup
  asks "link another?" Header/footer chrome, logo+favicon (served from `/public`),
  light theme, wordmark Fact=#4f46e5 / Radar=#dc2626.
- `factradar-core/` — `main.py` (FastAPI + rate limiter + `/ingest`), `pipeline.py`
  (LangGraph, top-5 claims, **balanced credibility** verdict prompt), `llm.py`
  (ollama/openai/claude), `retrieval.py` (DDG + Fact Check API), `media.py` (image
  OCR, audio/video transcription, video-frame OCR, **+ any-link**: yt-dlp video
  download → transcript/frame-OCR, page-text fallback, SSRF guard), `audit.py`
  (best-effort Mongo writes via thread pool). Media w/ ≥25 chars bypasses the
  check-worthiness gate. Verdict = 2 reply-quoted messages (summary + reasoning).
- `factradar-admin/` (`index.js`, `db.js`) — authenticated console (single
  `ADMIN_PASSWORD`, constant-time check, HMAC cookie). Dashboard: overview stats +
  **active devices** (defaults to linked; boot reconciliation marks stale ones
  unlinked) + live activity feed; per-device page; JSON API; approve/reject
  endpoints (decision recorded; **enforcement not wired** = the deferred approval queue).
- **MongoDB audit trail** shared by all three (see README for collections/events).
  Best-effort: unset/unreachable → services run, audit no-ops.
- Rate limiting protects the shared OpenAI key (per-session hour/day + global daily;
  per-IP link cap in ingest).

## Next steps (in priority order)

1. **Dockerfile** for core (tesseract + ffmpeg + yt-dlp) + Railway volume for `AUTH_DIR`
   + deploy the three services.
2. **Admin approval queue** — gate linking on admin approval (endpoints + audit exist;
   wire enforcement in ingest).
3. **Recycled-image detection** (perceptual hashing); **claim deduplication**.
4. **Next.js public dashboard** (verdict feed / review queue) beyond the admin console.
5. **Solicitor review** of the self-drafted Terms before serious public launch.
6. **Packaging** (later) — desktop distribution per URD; Android is a thin client only.

## Operational notes

- Three services run as background processes locally (not Docker): core via
  `.venv\Scripts\uvicorn main:app --port 41820 --env-file .env`, ingest + admin via
  `npm start`. Ollama optionally in Docker for the free path.
- Secrets live only in gitignored `.env` files (OpenAI key, Mongo creds, ADMIN_PASSWORD);
  `.env.example` templates are committed. Commits are authored as **simplysameer333**.

## Guardrails for any future work

- Don't add features that post publicly or DM senders without an explicit, confidence-gated,
  opt-in flag (Phase 2 only).
- Don't introduce a "monitor any number" capability.
- Keep the LLM call behind the single `get_llm()` interface.
- Treat the URD as the source of truth; update it when scope changes.
