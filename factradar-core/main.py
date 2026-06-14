"""factradar-core — FastAPI service.

Receives messages from factradar-ingest, runs the LangGraph pipeline, and posts
the verdict back. Multi-tenant: each message carries a session_id identifying the
user's WhatsApp session; verdicts go to that user's own "Message Yourself" chat.
"""

import logging
import os
import threading
import time
from collections import defaultdict, deque

import httpx
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import re

from pipeline import build_graph
from media import extract_media_text, extract_link_text
import audit

_URL_RE = re.compile(r"https?://\S+", re.I)

logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s - %(message)s")
log = logging.getLogger("factradar.core")

INGEST_URL = os.getenv("INGEST_URL", "http://localhost:41734")
OUTPUT_JID = os.getenv("OUTPUT_JID")  # e.g. your private log group: 12345-67890@g.us
CONFIDENCE_GATE = int(os.getenv("CONFIDENCE_GATE", "60"))

# --- Rate limiting (protects the shared OpenAI key on a public deployment) ---
# Per-user (WhatsApp session) caps stop one person flooding; the global daily cap
# is a hard ceiling on the whole bill. Tune via env. Counters are in-memory and
# reset on restart (good enough for v1; move to SQLite when persistence lands).
RATE_PER_SESSION_PER_HOUR = int(os.getenv("RATE_PER_SESSION_PER_HOUR", "15"))
RATE_PER_SESSION_PER_DAY = int(os.getenv("RATE_PER_SESSION_PER_DAY", "60"))
RATE_GLOBAL_PER_DAY = int(os.getenv("RATE_GLOBAL_PER_DAY", "800"))


class RateLimiter:
    """Sliding-window limiter: per-session (hour + day) and a global daily ceiling."""

    def __init__(self):
        self._sessions: dict[str, deque] = defaultdict(deque)
        self._global: deque = deque()
        self._notified: dict[str, float] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _prune(dq: deque, cutoff: float) -> None:
        while dq and dq[0] < cutoff:
            dq.popleft()

    def check_and_consume(self, key: str) -> str | None:
        """Return a reason string if blocked, or None if allowed (and counted)."""
        now = time.time()
        with self._lock:
            self._prune(self._global, now - 86400)
            if len(self._global) >= RATE_GLOBAL_PER_DAY:
                return "global_daily"
            s = self._sessions[key]
            self._prune(s, now - 86400)
            if len(s) >= RATE_PER_SESSION_PER_DAY:
                return "session_daily"
            if sum(1 for t in s if t >= now - 3600) >= RATE_PER_SESSION_PER_HOUR:
                return "session_hourly"
            s.append(now)
            self._global.append(now)
            return None

    def should_notify(self, key: str, min_gap: float = 600) -> bool:
        """True at most once per `min_gap` seconds per key — avoids notice spam."""
        now = time.time()
        with self._lock:
            if now - self._notified.get(key, 0) >= min_gap:
                self._notified[key] = now
                return True
            return False


rate_limiter = RateLimiter()

app = FastAPI(title="factradar-core", version="0.1.0")
graph = build_graph()


class Incoming(BaseModel):
    session_id: str | None = None  # which user's WhatsApp session this came from
    message_id: str
    chat_id: str
    is_group: bool = False
    sender_id: str | None = None
    type: str = "text"  # text | image | video | audio
    text: str | None = None  # message body or media caption
    media_b64: str | None = None  # base64 media bytes (image/video/voice note)
    mimetype: str | None = None  # WhatsApp-reported MIME type, e.g. image/jpeg
    timestamp: float | None = None


# Plain-language headline per label so the verdict is unmistakable at a glance
_HEADLINE = {
    "True": "\u2705 *TRUE* \u2014 this information checks out",
    "False": "\u274c *FALSE* \u2014 this information appears to be false",
    "Misleading": "\u26a0\ufe0f *MISLEADING* \u2014 partly true but distorted or missing context",
    "Unverified": "\u2753 *CANNOT BE VERIFIED* \u2014 no reliable evidence found either way",
}
_SHORT = {"True": "\u2705 TRUE", "False": "\u274c FALSE", "Misleading": "\u26a0\ufe0f MISLEADING", "Unverified": "\u2753 UNVERIFIED"}


def _source_ref(msg: Incoming) -> str:
    """A short reference to what's being checked, shown when no media is attached
    (links/text) so the user can tell which shared item the verdict is about."""
    if msg.media_b64:
        return ""  # the media itself is attached to the summary
    if msg.text:
        m = _URL_RE.search(msg.text)
        if m:
            return m.group(0)
        return msg.text[:80] + ("…" if len(msg.text) > 80 else "")
    return ""


def format_caption(results: list[dict], truncated: bool = False, source_ref: str = "") -> str:
    """Short summary (message 1). WhatsApp truncates media captions ~1024 chars, so
    full reasoning + sources go in the follow-up message."""
    lines = ["\U0001f50e *FactRadar verdict*"]
    if source_ref:
        lines.append(f"\U0001f517 _checking:_ {source_ref}")
    if truncated:
        lines.append(f"_Lots to check here \u2014 showing the {len(results)} most important claims._")
    for i, r in enumerate(results, 1):
        v = r["verdict"]
        claim = r["claim"]
        if len(claim) > 110:
            claim = claim[:107] + "..."
        prefix = f"{i}. " if len(results) > 1 else ""
        lines.append(f"{prefix}{_SHORT.get(v.get('label'), '\u2753 UNVERIFIED')} ({v.get('confidence', 0)}%) \u2014 {claim}")
    lines.append("_full reasoning + sources in the next message_ \u2b07\ufe0f")
    return "\n".join(lines)


def format_details(results: list[dict], src: Incoming, truncated: bool = False) -> str:
    """Full per-claim verdicts: headline, claim, reasoning, references (message 2)."""
    where = "a group" if src.is_group else "a chat"
    blocks = []
    if truncated:
        blocks.append(f"_This content had more than {len(results)} claims \u2014 checking the {len(results)} most important._")
    for i, r in enumerate(results, 1):
        v = r["verdict"]
        lines = []
        if len(results) > 1:
            lines.append(f"*Claim {i} of {len(results)}*")
        lines += [
            _HEADLINE.get(v.get("label"), _HEADLINE["Unverified"]),
            f"({v.get('confidence', 0)}% confidence)",
            "",
            f"*Claim checked:* {r['claim']}",
            "",
            v.get("rationale", ""),
        ]
        sources = (v.get("sources") or [])[:3]
        if sources:
            lines += ["", "*Check it yourself:*"] + [f"- {s}" for s in sources]
        blocks.append("\n".join(lines))
    sep = "\n\n" + "\u2500" * 20 + "\n\n"
    return sep.join(blocks) + f"\n\n_auto-checked claim shared in {where}_"


async def send_back(caption: str, details: str, src: Incoming) -> None:
    # Multi-tenant: deliver to the user's own self-chat ("me") via their session.
    # Single-tenant fallback: a fixed OUTPUT_JID when no session_id is present.
    jid = "me" if src.session_id else OUTPUT_JID
    if not src.session_id and not OUTPUT_JID:
        log.warning("no session_id and no OUTPUT_JID — verdict not delivered")
        return
    base = {"jid": jid, "session_id": src.session_id}
    async with httpx.AsyncClient(timeout=120) as c:
        # Message 1: the short summary. If the source was an uploaded image/video,
        # attach it (verdict as caption); for links/text the summary is its own message.
        # reply_to makes the summary a WhatsApp reply quoting the original message,
        # so it's visually tagged to the exact item being fact-checked.
        if src.media_b64 and src.type in ("image", "video"):
            r = await c.post(
                f"{INGEST_URL}/send",
                json={**base, "text": caption, "media_b64": src.media_b64,
                      "mimetype": src.mimetype, "media_type": src.type,
                      "reply_to": src.message_id},
            )
        else:
            r = await c.post(
                f"{INGEST_URL}/send",
                json={**base, "text": caption, "reply_to": src.message_id},
            )
        if r.status_code != 200:
            log.error("ingest /send (summary) failed: %s %s", r.status_code, r.text)
        # Message 2: the full reasoning + references — also reply-quote the original
        # so this message is tagged to the checked item too (not left floating).
        r = await c.post(f"{INGEST_URL}/send", json={**base, "text": details, "reply_to": src.message_id})
        if r.status_code != 200:
            log.error("ingest /send (details) failed: %s %s", r.status_code, r.text)
        else:
            log.info("verdict delivered (session=%s)", src.session_id)


async def notify_text(src: Incoming, text: str) -> None:
    """Send a plain text message to the user (no media echo) — used for notices."""
    jid = "me" if src.session_id else OUTPUT_JID
    if not src.session_id and not OUTPUT_JID:
        return
    async with httpx.AsyncClient(timeout=30) as c:
        await c.post(f"{INGEST_URL}/send", json={"jid": jid, "session_id": src.session_id, "text": text})


@app.post("/ingest")
async def ingest(msg: Incoming):
    # Rate limit BEFORE any costly work (OCR/transcription/LLM) to protect the
    # shared OpenAI key and CPU from a flood of inbound media.
    limited = rate_limiter.check_and_consume(msg.session_id or "default")
    if limited:
        log.warning("rate limited: %s (session=%s)", limited, msg.session_id)
        audit.record_event("check_rate_limited", sid=msg.session_id, detail={"reason": limited})
        # Tell the user once (per-session limits only; stay silent on the global cap).
        if limited != "global_daily" and msg.session_id and rate_limiter.should_notify(msg.session_id):
            await notify_text(
                msg,
                "⏳ You've reached your fact-check limit for now. Please try again later "
                "— this keeps the free service available to everyone.",
            )
        return {"skipped": f"rate_limited:{limited}"}

    # Media stage: turn images/video/voice notes — and YouTube links — into text,
    # then feed the same downstream pipeline. The caption (msg.text) is kept too.
    text = (msg.text or "").strip()
    is_media = bool(msg.media_b64)
    source_type = msg.type if msg.media_b64 else "text"

    if msg.media_b64:
        media_text = await run_in_threadpool(
            extract_media_text, msg.media_b64, msg.mimetype or "", msg.type
        )
        log.info("media extraction (%s): %d chars", msg.type, len(media_text))
        text = "\n".join(t for t in (text, media_text) if t).strip()
    elif msg.text and (m := _URL_RE.search(msg.text)):
        log.info("fetching link: %s", m.group(0))
        link_text, kind = await run_in_threadpool(extract_link_text, m.group(0))
        log.info("link extraction (%s): %d chars", kind or "none", len(link_text))
        if link_text:
            text = link_text  # the transcript/article is the claim source, not the bare link
            is_media = True   # bypass the weak check-worthiness gate for links
            source_type = "video" if kind == "video" else "text"

    if not text:
        log.info("skipping %s message: no text after extraction", msg.type)
        audit.record_event("check_skipped", sid=msg.session_id, detail={"reason": "no_text", "type": msg.type})
        return {"skipped": "no text"}

    # graph.invoke is sync; run off the event loop
    result = await run_in_threadpool(
        graph.invoke, {"text": text, "is_media": is_media, "source_type": source_type}
    )

    if not result.get("check_worthy"):
        log.info("not check-worthy: %.120s", text)
        audit.record_event("check_skipped", sid=msg.session_id, detail={"reason": "not_check_worthy", "source_type": source_type})
        return {"skipped": "not check-worthy"}

    results = [r for r in (result.get("results") or []) if r.get("verdict")]
    if not results:
        log.warning("check-worthy but no verdicts produced")
        audit.record_event("check_skipped", sid=msg.session_id, detail={"reason": "no_verdicts", "source_type": source_type})
        return {"skipped": "no verdicts"}

    for r in results:
        verdict = r["verdict"]
        # Confidence gate (FR-OUT-03): demote low-confidence calls to Unverified
        if int(verdict.get("confidence", 0)) < CONFIDENCE_GATE:
            verdict["label"] = "Unverified"
        log.info(
            "claim=%r verdict=%s conf=%s",
            r["claim"], verdict.get("label"), verdict.get("confidence"),
        )

    truncated = bool(result.get("claims_truncated"))
    await send_back(
        format_caption(results, truncated, _source_ref(msg)),
        format_details(results, msg, truncated),
        msg,
    )
    # Audit: record the completed check (drives daily check counts) + bump the
    # device's running total in the shared registry.
    audit.record_event(
        "check_completed",
        sid=msg.session_id,
        detail={
            "source_type": source_type,
            "claim_count": len(results),
            "truncated": truncated,
            "verdicts": [
                {
                    "label": r["verdict"].get("label"),
                    "confidence": r["verdict"].get("confidence"),
                }
                for r in results
            ],
        },
    )
    audit.bump_counters(msg.session_id, checks_total=1, claims_checked_total=len(results))
    return {
        "verdicts": [
            {"claim": r["claim"], **{k: r["verdict"].get(k) for k in ("label", "confidence")}}
            for r in results
        ]
    }


@app.get("/health")
def health():
    return {"ok": True, "llm_backend": os.getenv("LLM_BACKEND", "ollama")}
