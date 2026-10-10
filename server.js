import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const STANDARD_DAYS = Number(process.env.STANDARD_PAYOUT_WAIT_DAYS || 14);
const VERIFIED_DAYS = Number(process.env.VERIFIED_GROUP_PAYOUT_WAIT_DAYS || 3);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "tracker.json");

app.use(express.json({ limit: "80kb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();
function cacheGet(key, ttlMs) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > ttlMs) {
    cache.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(key, value) {
  cache.set(key, { value, time: Date.now() });
}

function cleanId(value) {
  const s = String(value ?? "").trim();
  return /^\d{1,20}$/.test(s) ? s : null;
}

function cleanName(value, max = 50) {
  const s = String(value ?? "").trim();
  return s && s.length <= max ? s : null;
}

function positiveInt(value, max = 10_000_000) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const supplied = String(req.headers["x-admin-token"] || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "Staff authorization required." });
  }
  next();
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ senders: [], transfers: [] }, null, 2));
  }
}

async function readData() {
  await ensureDataFile();
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      senders: Array.isArray(parsed.senders) ? parsed.senders : [],
      transfers: Array.isArray(parsed.transfers) ? parsed.transfers : []
    };
  } catch {
    return { senders: [], transfers: [] };
  }
}

let writeQueue = Promise.resolve();
function mutateData(mutator) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    return result;
  });
  return writeQueue;
}

async function resolveUsername(username) {
  const clean = String(username ?? "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(clean)) {
    throw new Error("Enter a valid Roblox username.");
  }

  const cacheKey = `user:${clean.toLowerCase()}`;
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) return cached;

  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [clean], excludeBannedUsers: false })
  });

  if (!response.ok) throw new Error("Roblox username lookup failed.");
  const body = await response.json();
  const user = body?.data?.[0];
  if (!user?.id) throw new Error("Roblox user not found.");

  const result = {
    id: String(user.id),
    name: user.name,
    displayName: user.displayName
  };
  cacheSet(cacheKey, result);
  return result;
}

async function getAvatar(userId) {
  const cacheKey = `avatar:${userId}`;
  const cached = cacheGet(cacheKey, 15 * 60_000);
  if (cached) return cached;

  const url = new URL("https://thumbnails.roblox.com/v1/users/avatar-headshot");
  url.searchParams.set("userIds", String(userId));
  url.searchParams.set("size", "150x150");
  url.searchParams.set("format", "Png");
  url.searchParams.set("isCircular", "false");

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = await response.json();
    const imageUrl = body?.data?.[0]?.imageUrl || null;
    if (imageUrl) cacheSet(cacheKey, imageUrl);
    return imageUrl;
  } catch {
    return null;
  }
}

async function openCloud(pathname) {
  const key = process.env.ROBLOX_API_KEY;
  if (!key) {
    const err = new Error("ROBLOX_API_KEY is not configured on the server.");
    err.status = 503;
    throw err;
  }

  const response = await fetch(`https://apis.roblox.com${pathname}`, {
    headers: { "x-api-key": key, Accept: "application/json" }
  });

  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }

  if (!response.ok) {
    const err = new Error(
      body?.message || body?.error?.message || `Roblox Open Cloud returned HTTP ${response.status}.`
    );
    err.status = response.status === 403 ? 403 : 502;
    throw err;
  }

  return body;
}

function senderUsage(sender, transfers, now = Date.now()) {
  const success = transfers.filter(t => t.senderId === sender.id && t.status === "success");
  const dayCutoff = now - 24 * 60 * 60 * 1000;
  const monthCutoff = now - 30 * 24 * 60 * 60 * 1000;
  const dayTx = success.filter(t => new Date(t.sentAt).getTime() >= dayCutoff);
  const monthTx = success.filter(t => new Date(t.sentAt).getTime() >= monthCutoff);
  const dayUsed = dayTx.reduce((sum, t) => sum + t.amount, 0);
  const monthUsed = monthTx.reduce((sum, t) => sum + t.amount, 0);

  const oldestDay = dayTx.map(t => new Date(t.sentAt).getTime()).sort((a,b) => a-b)[0];
  const oldestMonth = monthTx.map(t => new Date(t.sentAt).getTime()).sort((a,b) => a-b)[0];

  return {
    ...sender,
    dailyUsed: dayUsed,
    dailyRemaining: Math.max(0, sender.dailyLimit - dayUsed),
    monthlyUsed: monthUsed,
    monthlyRemaining: Math.max(0, sender.monthlyLimit - monthUsed),
    nextDailyReleaseAt: oldestDay ? new Date(oldestDay + 24 * 60 * 60 * 1000).toISOString() : null,
    nextMonthlyReleaseAt: oldestMonth ? new Date(oldestMonth + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
    limitReached: dayUsed >= sender.dailyLimit || monthUsed >= sender.monthlyLimit
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, tracker: true, adminProtected: Boolean(ADMIN_TOKEN) });
});

app.post("/api/check", async (req, res) => {
  try {
    const username = req.body?.username;
    const groupId = cleanId(req.body?.groupId);
    if (!groupId) return res.status(400).json({ ok: false, error: "Enter a valid Roblox group ID." });

    const user = await resolveUsername(username);
    const avatarUrl = await getAvatar(user.id);

    const [group, membershipData] = await Promise.all([
      openCloud(`/cloud/v2/groups/${encodeURIComponent(groupId)}`),
      openCloud(
        `/cloud/v2/groups/${encodeURIComponent(groupId)}/memberships` +
        `?maxPageSize=10&filter=${encodeURIComponent(`user == 'users/${user.id}'`)}`
      )
    ]);

    const membership = membershipData?.groupMemberships?.[0] ?? null;
    const base = {
      ok: true,
      user: { ...user, avatarUrl },
      group: { id: groupId, name: group.displayName || `Group ${groupId}`, verified: Boolean(group.verified) }
    };

    if (!membership) {
      return res.json({ ...base, joined: false, eligible: false, message: "This account is not currently a member of this group." });
    }

    if (!membership.createTime) {
      return res.json({ ...base, joined: true, eligible: null, message: "Membership exists, but Roblox did not return a join timestamp." });
    }

    const joinedAt = new Date(membership.createTime);
    if (Number.isNaN(joinedAt.getTime())) throw new Error("Roblox returned an invalid membership date.");

    const now = new Date();
    const waitDays = group.verified ? VERIFIED_DAYS : STANDARD_DAYS;
    const eligibleAt = new Date(joinedAt.getTime() + waitDays * 86400000);
    const eligible = now >= eligibleAt;
    const remainingHours = Math.ceil(Math.max(0, eligibleAt - now) / 3600000);

    const data = await readData();
    const userTransfers = data.transfers.filter(t => t.receiverRobloxId === user.id && t.status === "success");

    res.json({
      ...base,
      joined: true,
      eligible,
      membership: { joinedAt: joinedAt.toISOString(), waitDays, eligibleAt: eligibleAt.toISOString(), remainingHours },
      history: {
        totalReceived: userTransfers.reduce((sum, t) => sum + t.amount, 0),
        orders: userTransfers.length,
        lastSentAt: userTransfers.sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt))[0]?.sentAt || null
      },
      disclaimer: "Eligibility is estimated from Roblox membership age and your configured waiting period. Roblox can apply additional payout restrictions."
    });
  } catch (error) {
    console.error("Eligibility check error:", error.message);
    res.status(Number(error.status) || 500).json({ ok: false, error: error.message || "Something went wrong." });
  }
});

app.get("/api/overview", async (_req, res) => {
  const data = await readData();
  const successful = data.transfers.filter(t => t.status === "success");
  const now = Date.now();
  const dayCutoff = now - 24 * 60 * 60 * 1000;
  const monthCutoff = now - 30 * 24 * 60 * 60 * 1000;

  const totalSent = successful.reduce((sum, t) => sum + t.amount, 0);
  const sentToday = successful.filter(t => new Date(t.sentAt).getTime() >= dayCutoff).reduce((s,t) => s + t.amount, 0);
  const sent30Days = successful.filter(t => new Date(t.sentAt).getTime() >= monthCutoff).reduce((s,t) => s + t.amount, 0);
  const senders = data.senders.map(s => senderUsage(s, data.transfers, now));
  const recent = [...data.transfers].sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, 12);

  res.json({ ok: true, totalSent, sentToday, sent30Days, successfulOrders: successful.length, senders, recent });
});

app.get("/api/transfers", async (req, res) => {
  const data = await readData();
  const search = String(req.query.search || "").trim().toLowerCase();
  let transfers = [...data.transfers].sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt));
  if (search) {
    transfers = transfers.filter(t =>
      t.receiverUsername?.toLowerCase().includes(search) ||
      t.receiverRobloxId?.includes(search) ||
      t.orderId?.toLowerCase().includes(search)
    );
  }
  res.json({ ok: true, transfers: transfers.slice(0, 250) });
});

app.post("/api/transfers", requireAdmin, async (req, res) => {
  try {
    const senderId = cleanName(req.body?.senderId, 80);
    const username = cleanName(req.body?.username, 20);
    const amount = positiveInt(req.body?.amount, 1_000_000);
    const orderId = cleanName(req.body?.orderId || `RBX-${Date.now()}`, 100);
    if (!senderId || !username || !amount || !orderId) {
      return res.status(400).json({ ok: false, error: "Sender, Roblox username and a valid Robux amount are required." });
    }

    const user = await resolveUsername(username);
    const avatarUrl = await getAvatar(user.id);

    const transfer = await mutateData(async data => {
      const sender = data.senders.find(s => s.id === senderId && s.active !== false);
      if (!sender) throw Object.assign(new Error("Sending account not found or inactive."), { status: 400 });
      if (data.transfers.some(t => t.orderId === orderId)) {
        throw Object.assign(new Error("That order ID already exists."), { status: 409 });
      }

      const usage = senderUsage(sender, data.transfers);
      if (usage.dailyUsed + amount > sender.dailyLimit) {
        throw Object.assign(new Error(`This would exceed ${sender.name}'s tracked 24-hour limit.`), { status: 409 });
      }
      if (usage.monthlyUsed + amount > sender.monthlyLimit) {
        throw Object.assign(new Error(`This would exceed ${sender.name}'s tracked 30-day limit.`), { status: 409 });
      }

      const item = {
        id: crypto.randomUUID(), orderId, senderId: sender.id, senderName: sender.name,
        receiverRobloxId: user.id, receiverUsername: user.name, receiverDisplayName: user.displayName,
        receiverAvatarUrl: avatarUrl, amount, status: "success", sentAt: new Date().toISOString()
      };
      data.transfers.push(item);
      return item;
    });

    res.status(201).json({ ok: true, transfer });
  } catch (error) {
    res.status(Number(error.status) || 500).json({ ok: false, error: error.message || "Could not record transfer." });
  }
});

app.delete("/api/transfers/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  try {
    const removed = await mutateData(async data => {
      const index = data.transfers.findIndex(t => t.id === id);
      if (index < 0) return null;
      return data.transfers.splice(index, 1)[0];
    });
    if (!removed) return res.status(404).json({ ok: false, error: "Transfer not found." });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not remove transfer." });
  }
});

app.get("/api/senders", async (_req, res) => {
  const data = await readData();
  res.json({ ok: true, senders: data.senders.map(s => senderUsage(s, data.transfers)) });
});

app.post("/api/senders", requireAdmin, async (req, res) => {
  const name = cleanName(req.body?.name, 40);
  const robloxUserId = cleanId(req.body?.robloxUserId);
  const dailyLimit = positiveInt(req.body?.dailyLimit, 1_000_000);
  const monthlyLimit = positiveInt(req.body?.monthlyLimit, 10_000_000);
  if (!name || !robloxUserId || !dailyLimit || !monthlyLimit) {
    return res.status(400).json({ ok: false, error: "Name, Roblox user ID and valid limits are required." });
  }

  try {
    const sender = await mutateData(async data => {
      const item = {
        id: crypto.randomUUID(), name, robloxUserId, dailyLimit, monthlyLimit,
        avatarUrl: await getAvatar(robloxUserId), active: true, createdAt: new Date().toISOString()
      };
      data.senders.push(item);
      return item;
    });
    res.status(201).json({ ok: true, sender });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not add sending account." });
  }
});

app.patch("/api/senders/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  try {
    const updated = await mutateData(async data => {
      const sender = data.senders.find(s => s.id === id);
      if (!sender) return null;
      if (req.body?.name !== undefined) sender.name = cleanName(req.body.name, 40) || sender.name;
      if (req.body?.dailyLimit !== undefined) sender.dailyLimit = positiveInt(req.body.dailyLimit, 1_000_000) || sender.dailyLimit;
      if (req.body?.monthlyLimit !== undefined) sender.monthlyLimit = positiveInt(req.body.monthlyLimit, 10_000_000) || sender.monthlyLimit;
      if (req.body?.active !== undefined) sender.active = Boolean(req.body.active);
      return sender;
    });
    if (!updated) return res.status(404).json({ ok: false, error: "Sending account not found." });
    res.json({ ok: true, sender: updated });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not update sending account." });
  }
});

app.listen(PORT, () => {
  console.log(`HENGGOLIVER checker + tracker running on port ${PORT}`);
  console.log(`Tracker data file: ${DATA_FILE}`);
});
