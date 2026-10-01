const express = require('express');
const { pool } = require('../db');
const wrap = require('../middleware/wrap');
const { requireAuth } = require('../middleware/auth');
const { getUsage } = require('../services/usage');

const router = express.Router();
router.use(requireAuth);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CONVERSATIONS = 300;     // bootstrap me itni recent chats load hoti hain
const MAX_MESSAGES = 1000;
const MAX_MSG_CHARS = 100000;

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const num = (v, fallback) => (Number.isFinite(v) ? Math.trunc(v) : fallback);

// Sirf yahi settings save hongi (unknown keys ignore)
const SETTING_TYPES = {
  language: 'string', density: 'string', fontSize: 'string', theme: 'string', defaultModel: 'string',
  autoSave: 'boolean', enterToSend: 'boolean', showTimestamps: 'boolean', notifications: 'boolean', privacyMode: 'boolean'
};
function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, t] of Object.entries(SETTING_TYPES)) {
    const v = input[k];
    if (typeof v === t && (t !== 'string' || v.length <= 32)) out[k] = v;
  }
  return out;
}

// ---------- Bootstrap: login ke baad ek call me sab kuch ----------
router.get('/bootstrap', wrap(async (req, res) => {
  const uid = req.user.id;
  const [settings, convs, projects, usage] = await Promise.all([
    pool.query('SELECT settings FROM users WHERE id = $1', [uid]),
    pool.query(
      `SELECT id, title, starred, archived, created_at, updated_at FROM conversations
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [uid, MAX_CONVERSATIONS]),
    pool.query('SELECT data FROM projects WHERE user_id = $1 ORDER BY created_at ASC', [uid]),
    getUsage(req.user)
  ]);

  const ids = convs.rows.map((c) => c.id);
  const msgs = ids.length
    ? await pool.query(
        `SELECT conversation_id, id, role, raw, attachments, created_at FROM messages
         WHERE user_id = $1 AND conversation_id = ANY($2) ORDER BY conversation_id, position`, [uid, ids])
    : { rows: [] };

  const byConv = new Map();
  for (const m of msgs.rows) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id).push({
      id: m.id, role: m.role, text: m.raw, attachments: m.attachments, timestamp: Number(m.created_at)
    });
  }

  res.json({
    user: {
      id: req.user.id, name: req.user.name, email: req.user.email, username: req.user.username,
      plan: req.user.plan, createdAt: new Date(req.user.created_at).getTime()
    },
    settings: settings.rows[0] ? settings.rows[0].settings : {},
    conversations: convs.rows.map((c) => ({
      id: c.id, title: c.title, starred: c.starred, archived: c.archived,
      createdAt: Number(c.created_at), updatedAt: Number(c.updated_at),
      messages: byConv.get(c.id) || []
    })),
    projects: projects.rows.map((p) => p.data),
    usage
  });
}));

// ---------- Conversations ----------
router.put('/conversations/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  if (!ID_RE.test(id)) return bad(res, 'Invalid conversation id');
  if (!Array.isArray(b.messages) || b.messages.length > MAX_MESSAGES) return bad(res, 'Invalid messages');

  const title = (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'New chat').slice(0, 200);
  const now = Date.now();
  const createdAt = num(b.createdAt, now);
  const updatedAt = num(b.updatedAt, now);

  const rows = [];
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i];
    if (!m || !ID_RE.test(String(m.id)) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') {
      return bad(res, 'Invalid message');
    }
    const atts = Array.isArray(m.attachments)
      ? m.attachments.slice(0, 10).map((a) => ({
          id: String(a.id || '').slice(0, 64), name: String(a.name || '').slice(0, 200),
          size: num(a.size, 0), type: String(a.type || '').slice(0, 100), isImage: !!a.isImage
        }))
      : [];
    rows.push([String(m.id), i, m.role, m.text.slice(0, MAX_MSG_CHARS), JSON.stringify(atts), num(m.timestamp, now)]);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO conversations (user_id, id, title, starred, archived, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, id) DO UPDATE
         SET title = EXCLUDED.title, starred = EXCLUDED.starred, archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at`,
      [req.user.id, id, title, !!b.starred, !!b.archived, createdAt, updatedAt]);
    await client.query('DELETE FROM messages WHERE user_id = $1 AND conversation_id = $2', [req.user.id, id]);
    if (rows.length) {
      const values = [];
      const params = [req.user.id, id];
      rows.forEach((r, i) => {
        const o = params.length;
        params.push(...r);
        values.push(`($1,$2,$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::jsonb,$${o + 6})`);
      });
      await client.query(
        `INSERT INTO messages (user_id, conversation_id, id, position, role, raw, attachments, created_at)
         VALUES ${values.join(',')}`, params);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

router.delete('/conversations/:id', wrap(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return bad(res, 'Invalid conversation id');
  await pool.query('DELETE FROM conversations WHERE user_id = $1 AND id = $2', [req.user.id, req.params.id]);
  res.json({ ok: true });
}));

// ---------- Projects (poori list replace) ----------
router.put('/projects', wrap(async (req, res) => {
  const list = req.body && req.body.projects;
  if (!Array.isArray(list) || list.length > 200) return bad(res, 'Invalid projects');
  for (const p of list) {
    if (!p || !ID_RE.test(String(p.id)) || JSON.stringify(p).length > 200000) return bad(res, 'Invalid project');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM projects WHERE user_id = $1', [req.user.id]);
    for (const p of list) {
      await client.query('INSERT INTO projects (user_id, id, data, created_at) VALUES ($1,$2,$3,$4)',
        [req.user.id, String(p.id), JSON.stringify(p), num(p.createdAt, Date.now())]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ---------- Settings ----------
router.put('/settings', wrap(async (req, res) => {
  const settings = cleanSettings(req.body && req.body.settings);
  await pool.query('UPDATE users SET settings = $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(settings)]);
  res.json({ ok: true });
}));

// ---------- Usage ----------
router.get('/usage', wrap(async (req, res) => res.json(await getUsage(req.user))));

// ---------- Saara chat data delete (account rehta hai) ----------
router.delete('/data', wrap(async (req, res) => {
  await pool.query('DELETE FROM conversations WHERE user_id = $1', [req.user.id]);
  await pool.query('DELETE FROM projects WHERE user_id = $1', [req.user.id]);
  await pool.query("UPDATE users SET settings = '{}'::jsonb WHERE id = $1", [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
