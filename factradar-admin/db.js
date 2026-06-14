// factradar-admin — MongoDB access layer.
//
// Reads the audit trail written by factradar-ingest (device lifecycle, messages,
// verdicts) and factradar-core (checks), and writes admin decisions
// (approve/reject) back onto the device registry. Same cluster/db as the other
// two services (MONGODB_URI / MONGODB_DB).

import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "factradar";

let client = null;
let connecting = null;
let dbRef = null;

export async function getDb() {
  if (dbRef) return dbRef;
  if (!URI) throw new Error("MONGODB_URI is not set — admin needs the audit database");
  if (!connecting) {
    client = new MongoClient(URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    connecting = client.connect().then(() => {
      dbRef = client.db(DB_NAME);
      return dbRef;
    });
  }
  return connecting;
}

// ---- reads ----------------------------------------------------------------

export async function listDevices({ status = null, limit = 500 } = {}) {
  const db = await getDb();
  const q = status ? { status } : {};
  return db.collection("devices").find(q).sort({ updatedAt: -1 }).limit(limit).toArray();
}

export async function getDevice(sid) {
  const db = await getDb();
  return db.collection("devices").findOne({ _id: sid });
}

export async function listEvents({ sid = null, type = null, limit = 200 } = {}) {
  const db = await getDb();
  const q = {};
  if (sid) q.sid = sid;
  if (type) q.type = type;
  return db.collection("audit_events").find(q).sort({ ts: -1 }).limit(limit).toArray();
}

// Headline numbers for the dashboard.
export async function overview() {
  const db = await getDb();
  const devices = db.collection("devices");
  const events = db.collection("audit_events");

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [byStatus, totalDevices, checksToday, checksTotal, rateLimitedToday] = await Promise.all([
    devices.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    devices.countDocuments({}),
    events.countDocuments({ type: "check_completed", ts: { $gte: startOfToday } }),
    events.countDocuments({ type: "check_completed" }),
    events.countDocuments({ type: "check_rate_limited", ts: { $gte: startOfToday } }),
  ]);

  const status = {};
  for (const r of byStatus) status[r._id || "unknown"] = r.n;
  return { totalDevices, status, checksToday, checksTotal, rateLimitedToday };
}

// Daily checks per device for the last `days` days.
export async function dailyChecks(days = 30) {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86400 * 1000);
  return db
    .collection("audit_events")
    .aggregate([
      { $match: { type: "check_completed", ts: { $gte: since } } },
      {
        $group: {
          _id: { sid: "$sid", day: { $dateToString: { format: "%Y-%m-%d", date: "$ts" } } },
          checks: { $sum: 1 },
          claims: { $sum: "$detail.claim_count" },
        },
      },
      { $sort: { "_id.day": -1, checks: -1 } },
    ])
    .toArray();
}

// ---- writes (admin decisions) ---------------------------------------------

// Approve / reject a device's link request. Records the decision on the device
// doc AND appends an audit event so the trail captures who/when. Enforcement
// (blocking unapproved sessions from being served) is wired in ingest later.
export async function setApproval(sid, approved, by = "admin") {
  const db = await getDb();
  const now = new Date();
  await db.collection("devices").updateOne(
    { _id: sid },
    {
      $set: {
        approval: approved ? "approved" : "rejected",
        approvedAt: approved ? now : null,
        rejectedAt: approved ? null : now,
        approvedBy: by,
        updatedAt: now,
      },
    }
  );
  await db.collection("audit_events").insertOne({
    ts: now,
    service: "admin",
    type: approved ? "device_approved" : "device_rejected",
    sid,
    detail: { by },
  });
  return getDevice(sid);
}
