// factradar-ingest — MongoDB audit trail.
//
// Records the full lifecycle of every linked device: when a user accepts the
// Terms, when a QR is shown, when the account links / reconnects / unlinks, every
// message forwarded for checking, and every verdict delivered. Two collections:
//
//   devices       — one registry doc per session (status, jid/phone, consent,
//                   linkedAt/unlinkedAt, rolling counters). Survives until the
//                   user unregisters (we mark it "unlinked", never delete it).
//   audit_events  — append-only event log (one doc per event) for a full trail.
//
// Everything here is BEST-EFFORT: if Mongo is unreachable or MONGODB_URI is not
// set, audit silently no-ops and the service keeps working. Audit must never
// break linking or fact-checking.

import { MongoClient } from "mongodb";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "audit" });

const URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "factradar";

let client = null;
let connecting = null; // Promise<db|null> while connecting; resolved db afterwards
let dbRef = null;

async function getDb() {
  if (dbRef) return dbRef;
  if (!URI) return null; // audit disabled when not configured
  if (!connecting) {
    client = new MongoClient(URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    connecting = client
      .connect()
      .then(async () => {
        const db = client.db(DB_NAME);
        await db.collection("audit_events").createIndex({ ts: -1 });
        await db.collection("audit_events").createIndex({ sid: 1, ts: -1 });
        await db.collection("audit_events").createIndex({ type: 1, ts: -1 });
        await db.collection("devices").createIndex({ jid: 1 });
        await db.collection("devices").createIndex({ status: 1 });
        dbRef = db;
        log.info("connected to MongoDB audit store");
        return db;
      })
      .catch((e) => {
        log.error({ err: String(e) }, "MongoDB connect failed — audit disabled");
        connecting = null; // allow a later retry
        return null;
      });
  }
  return connecting;
}

export function phoneFromJid(jid) {
  if (!jid) return null;
  const m = String(jid).match(/^(\d+)/);
  return m ? m[1] : null;
}

// Append an immutable event. Fire-and-forget; never throws.
export async function recordEvent(type, { sid = null, jid = null, detail = {} } = {}) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection("audit_events").insertOne({
      ts: new Date(),
      service: "ingest",
      type,
      sid,
      jid,
      phone: phoneFromJid(jid),
      detail,
    });
  } catch (e) {
    log.warn({ err: String(e), type }, "recordEvent failed");
  }
}

// Upsert the device registry doc. `set` overwrites fields; `inc` bumps counters.
// Never throws.
export async function upsertDevice(sid, set = {}, inc = {}) {
  if (!sid) return;
  try {
    const db = await getDb();
    if (!db) return;
    const update = {
      $set: { ...set, sid, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    };
    if (Object.keys(inc).length) update.$inc = inc;
    await db.collection("devices").updateOne({ _id: sid }, update, { upsert: true });
  } catch (e) {
    log.warn({ err: String(e), sid }, "upsertDevice failed");
  }
}

// Is this WhatsApp account (jid) already listed as a linked device in the DB?
// Used to reject a duplicate even across restarts. Best-effort: returns false if
// the DB is unreachable (never block a genuine link because audit is down).
export async function isJidLinked(jid, excludeSid) {
  try {
    const db = await getDb();
    if (!db || !jid) return false;
    const q = { jid, status: "linked" };
    if (excludeSid) q._id = { $ne: excludeSid };
    return (await db.collection("devices").countDocuments(q)) > 0;
  } catch (e) {
    log.warn({ err: String(e) }, "isJidLinked failed");
    return false;
  }
}

// Mark any device the DB still thinks is live (linked/linking) but which has no
// resumable session anymore as "unlinked" — keeps the registry honest across
// restarts/crashes so the admin never shows a discontinued session as active.
export async function reconcileLinked(activeSids = []) {
  try {
    const db = await getDb();
    if (!db) return;
    const r = await db.collection("devices").updateMany(
      { status: { $in: ["linked", "linking"] }, _id: { $nin: activeSids } },
      { $set: { status: "unlinked", unlinkedAt: new Date(), updatedAt: new Date() } }
    );
    if (r.modifiedCount) log.info({ n: r.modifiedCount }, "reconciled stale linked devices -> unlinked");
  } catch (e) {
    log.warn({ err: String(e) }, "reconcileLinked failed");
  }
}

// ---- read side (admin) ----------------------------------------------------

export async function listDevices() {
  const db = await getDb();
  if (!db) return [];
  return db.collection("devices").find({}).sort({ updatedAt: -1 }).limit(500).toArray();
}

export async function listEvents(query = {}, limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.collection("audit_events").find(query).sort({ ts: -1 }).limit(limit).toArray();
}

// Daily check counts per device, from check_completed events (last `days` days).
export async function dailyChecks(days = 30) {
  const db = await getDb();
  if (!db) return [];
  const since = new Date(Date.now() - days * 86400 * 1000);
  return db
    .collection("audit_events")
    .aggregate([
      { $match: { type: "check_completed", ts: { $gte: since } } },
      {
        $group: {
          _id: {
            sid: "$sid",
            day: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } },
          },
          checks: { $sum: 1 },
          claims: { $sum: "$detail.claim_count" },
        },
      },
      { $sort: { "_id.day": -1 } },
    ])
    .toArray();
}

export async function isEnabled() {
  return Boolean(await getDb());
}
