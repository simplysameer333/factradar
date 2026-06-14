"""Media -> text extraction (Next steps #1).

Turns images / video / voice notes into plain text so the existing LangGraph
text pipeline can run unchanged:

  - images       : OCR via Tesseract (pytesseract + Pillow)
  - voice notes  : transcription via faster-whisper
  - video        : audio transcription (faster-whisper) + sampled-frame OCR (ffmpeg)

Everything here is best-effort: a missing system binary or a decode failure
returns "" and logs a warning rather than crashing the pipeline, matching the
"never let it crash the pipeline" stance in retrieval.py. The heavy Whisper
model and all optional imports are loaded lazily so a text-only deployment never
pays for them.

System dependencies (install separately, not pip):
  - Tesseract OCR  -> image / video-frame text   (set TESSERACT_CMD if not on PATH)
  - ffmpeg         -> video-frame sampling        (set FFMPEG_CMD if not on PATH)
faster-whisper bundles its own decoder, so audio transcription needs no ffmpeg.
"""

import base64
import html
import io
import ipaddress
import logging
import os
import re
import socket
import subprocess
import sys
import tempfile
from functools import lru_cache
from urllib.parse import urlparse

import httpx

log = logging.getLogger("factradar.media")

# How many evenly-spaced frames to OCR from a video (0 disables video-frame OCR).
VIDEO_OCR_FRAMES = int(os.getenv("VIDEO_OCR_FRAMES", "3"))
# faster-whisper model size + runtime. "base" is a good CPU default; "small"/"medium"
# are more accurate but slower. int8 keeps CPU memory/latency low.
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")


def extract_media_text(media_b64: str, mimetype: str = "", mtype: str = "") -> str:
    """Decode base64 media and return any text we can pull out of it.

    `mimetype` is the WhatsApp-reported MIME type (e.g. image/jpeg, audio/ogg,
    video/mp4); `mtype` is the coarse ingest type ("image"/"video"/"audio") used
    as a fallback when the MIME type is missing.
    """
    try:
        data = base64.b64decode(media_b64)
    except Exception as e:
        log.warning("could not decode media base64: %s", e)
        return ""

    kind = _classify(mimetype, mtype)
    if kind == "image":
        return ocr_image_bytes(data)
    if kind == "audio":
        return _transcribe_bytes(data, suffix=_suffix(mimetype, ".ogg"))
    if kind == "video":
        return _process_video(data, suffix=_suffix(mimetype, ".mp4"))

    log.info("unsupported media kind (mimetype=%r type=%r) — skipping", mimetype, mtype)
    return ""


# ---- images ----------------------------------------------------------------

def ocr_image_bytes(data: bytes) -> str:
    """OCR an in-memory image with Tesseract. Returns "" on any failure."""
    try:
        import pytesseract
        from PIL import Image

        cmd = os.getenv("TESSERACT_CMD")
        if cmd:
            pytesseract.pytesseract.tesseract_cmd = cmd

        with Image.open(io.BytesIO(data)) as img:
            text = pytesseract.image_to_string(img)
        return _clean(text)
    except Exception as e:
        log.warning("image OCR failed: %s", e)
        return ""


# ---- audio / video ---------------------------------------------------------

@lru_cache(maxsize=1)
def _whisper():
    """Load the faster-whisper model once and cache it (it is expensive)."""
    from faster_whisper import WhisperModel

    log.info("loading faster-whisper model=%s device=%s", WHISPER_MODEL, WHISPER_DEVICE)
    return WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)


def transcribe_file(path: str) -> str:
    """Transcribe the audio track of an audio OR video file. "" on failure."""
    try:
        model = _whisper()
        segments, _info = model.transcribe(path)
        return _clean(" ".join(seg.text for seg in segments))
    except Exception as e:
        log.warning("transcription failed: %s", e)
        return ""


def _transcribe_bytes(data: bytes, suffix: str) -> str:
    path = _to_tempfile(data, suffix)
    try:
        return transcribe_file(path)
    finally:
        _rm(path)


def _process_video_file(path: str) -> str:
    """A video file on disk -> spoken-word transcript + on-screen text from frames."""
    parts = [transcribe_file(path), _ocr_video_frames(path)]
    return _clean("\n".join(p for p in parts if p))


def _process_video(data: bytes, suffix: str) -> str:
    path = _to_tempfile(data, suffix)
    try:
        return _process_video_file(path)
    finally:
        _rm(path)


# Caps for link downloads (protect bandwidth/time on a public deploy).
YT_MAX_DURATION = int(os.getenv("YT_MAX_DURATION", "1200"))  # seconds (20 min)
YT_MAX_FILESIZE = os.getenv("YT_MAX_FILESIZE", "80M")
PAGE_MAX_CHARS = int(os.getenv("PAGE_MAX_CHARS", "1500"))


def extract_link_text(url: str) -> tuple[str, str]:
    """Pull checkable text out of ANY shared link.

    Returns (text, kind). Tries a video download first (yt-dlp covers YouTube,
    X/Twitter, Facebook, Instagram, TikTok and 1000+ sites) -> transcript + frame
    OCR; if there's no video (an article or text post), falls back to the page's
    own text (title + description + body). kind is "video", "page", or "".
    """
    if not _is_safe_url(url):
        log.warning("blocked unsafe url: %s", url)
        return ("", "")
    vid = _download_video_text(url)
    if vid:
        return (vid, "video")
    page = _fetch_page_text(url)
    if page:
        return (page, "page")
    return ("", "")


def _download_video_text(url: str) -> str:
    """yt-dlp download (capped) -> transcript + on-screen text. "" if no video."""
    out = tempfile.mktemp(suffix=".mp4", prefix="factradar_link_")
    try:
        subprocess.run(
            [sys.executable, "-m", "yt_dlp", "-q", "--no-playlist",
             "--max-filesize", YT_MAX_FILESIZE,
             "--match-filter", f"duration < {YT_MAX_DURATION}",
             "-f", "best[height<=480][ext=mp4]/best[ext=mp4]/worst",
             "-o", out, url],
            check=True, capture_output=True, timeout=300,
        )
        return _process_video_file(out) if os.path.exists(out) else ""
    except subprocess.CalledProcessError as e:
        log.info("no downloadable video at %s (%s)", url, (e.stderr or b"")[:160])
        return ""
    except Exception as e:
        log.warning("video link extraction failed: %s", e)
        return ""
    finally:
        _rm(out)


def _fetch_page_text(url: str) -> str:
    """Fetch a page and pull its key text: og:title/description + <title> + body."""
    try:
        r = httpx.get(
            url, timeout=20, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; FactRadar/1.0)"},
        )
        r.raise_for_status()
        doc = r.text

        def meta(name: str) -> str:
            m = re.search(
                rf'<meta[^>]+(?:property|name)=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)',
                doc, re.I,
            ) or re.search(
                rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{re.escape(name)}["\']',
                doc, re.I,
            )
            return html.unescape(m.group(1)).strip() if m else ""

        title_m = re.search(r"<title[^>]*>([^<]+)", doc, re.I)
        title = meta("og:title") or (html.unescape(title_m.group(1)).strip() if title_m else "")
        desc = meta("og:description") or meta("description") or meta("twitter:description")

        body = ""
        if len(f"{title} {desc}") < 120:  # thin meta — grab some visible body text
            stripped = re.sub(r"(?is)<(script|style|noscript|head)[^>]*>.*?</\1>", " ", doc)
            stripped = re.sub(r"(?s)<[^>]+>", " ", stripped)
            body = _clean(html.unescape(stripped))[:PAGE_MAX_CHARS]

        return _clean(" ".join(p for p in (title, desc, body) if p))[:PAGE_MAX_CHARS]
    except Exception as e:
        log.warning("page fetch failed for %s: %s", url, e)
        return ""


def _is_safe_url(url: str) -> bool:
    """Block non-http(s) and private/loopback hosts (basic SSRF guard)."""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        for *_, sockaddr in socket.getaddrinfo(p.hostname, None):
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        return True
    except Exception:
        return False


def _ocr_video_frames(video_path: str) -> str:
    """Sample frames with ffmpeg and OCR them — catches text baked into the video."""
    if VIDEO_OCR_FRAMES <= 0:
        return ""
    ffmpeg = os.getenv("FFMPEG_CMD", "ffmpeg")
    out_dir = tempfile.mkdtemp(prefix="factradar_frames_")
    try:
        pattern = os.path.join(out_dir, "frame_%02d.png")
        # One frame every 2s, capped at VIDEO_OCR_FRAMES.
        subprocess.run(
            [ffmpeg, "-nostdin", "-loglevel", "error", "-i", video_path,
             "-vf", "fps=1/2", "-frames:v", str(VIDEO_OCR_FRAMES), pattern],
            check=True, capture_output=True, timeout=120,
        )
        texts = []
        for name in sorted(os.listdir(out_dir)):
            with open(os.path.join(out_dir, name), "rb") as f:
                t = ocr_image_bytes(f.read())
            if t:
                texts.append(t)
        return "\n".join(texts)
    except FileNotFoundError:
        log.warning("ffmpeg not found (set FFMPEG_CMD) — skipping video-frame OCR")
        return ""
    except Exception as e:
        log.warning("video-frame OCR failed: %s", e)
        return ""
    finally:
        _rmtree(out_dir)


# ---- helpers ---------------------------------------------------------------

def _classify(mimetype: str, mtype: str) -> str:
    mimetype = (mimetype or "").lower()
    if mimetype.startswith("image/"):
        return "image"
    if mimetype.startswith("audio/"):
        return "audio"
    if mimetype.startswith("video/"):
        return "video"
    return (mtype or "").lower()  # fall back to the coarse ingest type


def _suffix(mimetype: str, default: str) -> str:
    """Best-effort file extension from a MIME type, for temp files."""
    if mimetype and "/" in mimetype:
        ext = mimetype.split("/", 1)[1].split(";")[0].strip()
        # ogg voice notes are reported as audio/ogg; codecs param already stripped
        if ext:
            return "." + ext
    return default


def _clean(text: str) -> str:
    # OCR/transcripts can carry lone surrogates (undecodable bytes) that later
    # crash JSON/UTF-8 encoding — strip them here so nothing downstream sees them
    text = (text or "").encode("utf-8", "replace").decode("utf-8", "replace")
    return " ".join(text.split()).strip()


def _to_tempfile(data: bytes, suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="factradar_media_")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _rm(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _rmtree(path: str) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=True)
