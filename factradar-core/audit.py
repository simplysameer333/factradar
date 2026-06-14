"""factradar-core — MongoDB audit trail (best-effort).

The core records the fact-checking side of the trail: every check that ran
(per session), how many claims it produced, the verdict labels/confidences, and
when a check was rate-limited or skipped. It also bumps rolling counters on the
shared `devices` registry (created by the ingest service) so each device's total
check count is available at a glance; `check_completed` events carry timestamps
so daily counts can be aggregated.

Best-effort, exactly like media.py/retrieval.py: writes run in a tiny background
thread pool (so they never block the event loop) and every failure is swallowed
with a warning. If MONGODB_URI is unset or Mongo is unreachable, audit no-ops
and fact-checking continues unaffected.
"""

import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

log = logging.getLogger("factradar.audit")

MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DB = os.getenv("MONGODB_DB", "factradar")

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="audit")
_client = None
_db = None
_init_failed = False


def _now():
    return datetime.now(timezone.utc)


def _get_db():
    """Lazily connect to Mongo. Returns the db handle or None if unavailable."""
    global _client, _db, _init_failed
    if _db is not None:
        return _db
    if _init_failed or not MONGODB_URI:
        return None
    try:
        from pymongo import MongoClient

        _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000, maxPoolSize=5)
        db = _client[MONGODB_DB]
        db["audit_events"].create_index([("ts", -1)])
        db["audit_events"].create_index([("sid", 1), ("ts", -1)])
        db["audit_events"].create_index([("type", 1), ("ts", -1)])
        _db = db
        log.info("connected to MongoDB audit store")
        return _db
    except Exception as e:
        _init_failed = True  # don't hammer a broken connection on every check
        log.warning("MongoDB connect failed — audit disabled: %s", e)
        return None


def _phone_from_jid(jid):
    if not jid:
        return None
    m = re.match(r"(\d+)", str(jid))
    return m.group(1) if m else None


def _do_record(event_type, sid, jid, detail):
    db = _get_db()
    if db is None:
        return
    try:
        db["audit_events"].insert_one(
            {
                "ts": _now(),
                "service": "core",
                "type": event_type,
                "sid": sid,
                "jid": jid,
                "phone": _phone_from_jid(jid),
                "detail": detail or {},
            }
        )
    except Exception as e:
        log.warning("audit insert failed (%s): %s", event_type, e)


def record_event(event_type, sid=None, jid=None, detail=None):
    """Fire-and-forget audit event. Never blocks the caller or raises."""
    try:
        _executor.submit(_do_record, event_type, sid, jid, detail)
    except Exception:
        pass


def _do_bump(sid, inc):
    db = _get_db()
    if db is None or not sid:
        return
    try:
        db["devices"].update_one(
            {"_id": sid},
            {"$inc": inc, "$set": {"updatedAt": _now(), "lastCheckAt": _now()}},
            upsert=True,
        )
    except Exception as e:
        log.warning("audit counter bump failed: %s", e)


def bump_counters(sid, **inc):
    """Increment rolling counters on the device registry doc (fire-and-forget)."""
    if not sid or not inc:
        return
    try:
        _executor.submit(_do_bump, sid, inc)
    except Exception:
        pass
