const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const wrap = require('../middleware/wrap');
const { issueToken, clearToken, requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
// Email exist na karne par bhi timing same rakhne ke liye dummy hash
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, username: u.username, plan: u.plan,
  createdAt: u.created_at ? new Date(u.created_at).getTime() : Date.now()
});

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (pw.length > 128) return 'Password is too long';
  return null;
}

router.post('/signup', authLimiter, wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 320).toLowerCase();
  const password = req.body.password;
  if (!name) return bad(res, 'Full name is required');
  if (!EMAIL_RE.test(email)) return bad(res, 'Please enter a valid email');
  const pwErr = checkPassword(password);
  if (pwErr) return bad(res, pwErr);

  const hash = await bcrypt.hash(password, 12);
  const id = 'user_' + crypto.randomUUID();
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, username, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, username, plan, created_at`,
      [id, name, email, email.split('@')[0].slice(0, 40), hash]);
    issueToken(res, id, true);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'An account with this email already exists', 409);
    throw e;
  }
}));

router.post('/signin', authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 320).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const remember = req.body.remember !== false;
  if (!email || !password) return bad(res, 'Email and password are required');

  const { rows } = await pool.query(
    'SELECT id, name, email, username, plan, created_at, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return bad(res, 'Invalid email or password', 401);

  issueToken(res, user.id, remember);
  res.json({ user: publicUser(user) });
}));

router.post('/signout', (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/profile', requireAuth, wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const username = str(req.body.username, 40);
  const email = str(req.body.email, 320).toLowerCase();
  if (!name) return bad(res, 'Name is required');
  if (!EMAIL_RE.test(email)) return bad(res, 'Please enter a valid email');
  try {
    const { rows } = await pool.query(
      `UPDATE users SET name = $2, username = $3, email = $4 WHERE id = $1
       RETURNING id, name, email, username, plan, created_at`,
      [req.user.id, name, username, email]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'That email is already in use', 409);
    throw e;
  }
}));

router.post('/password', requireAuth, authLimiter, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const pwErr = checkPassword(next);
  if (pwErr) return bad(res, pwErr);
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    return bad(res, 'Current password is incorrect', 401);
  }
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, 12)]);
  res.json({ ok: true });
}));

router.post('/forgot', authLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 320).toLowerCase();
  // Hamesha same response, taaki pata na chale email registered hai ya nahi
  const generic = { ok: true };
  if (!EMAIL_RE.test(email)) return res.json(generic);

  const { rows } = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
  if (rows[0]) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [rows[0].id]);
    await pool.query(
      "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [sha256(token), rows[0].id]);
    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const link = `${base}/?reset=${token}`;
    await sendMail({
      to: email,
      subject: 'Reset your SquareAI password',
      text: `Hi ${rows[0].name},\n\nUse this link to reset your password (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this email.`,
      html: `<p>Hi ${String(rows[0].name).replace(/[<>&"]/g, '')},</p><p><a href="${link}">Reset your password</a> (valid for 1 hour).</p><p>If you did not request this, ignore this email.</p>`
    });
  }
  res.json(generic);
}));

router.post('/reset', authLimiter, wrap(async (req, res) => {
  const token = str(req.body.token, 200);
  const pwErr = checkPassword(req.body.password);
  if (pwErr) return bad(res, pwErr);
  if (!/^[a-f0-9]{64}$/.test(token)) return bad(res, 'This reset link is invalid or has expired');

  const { rows } = await pool.query(
    'DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > now() RETURNING user_id', [sha256(token)]);
  if (!rows[0]) return bad(res, 'This reset link is invalid or has expired');

  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [rows[0].user_id, await bcrypt.hash(req.body.password, 12)]);
  const u = await pool.query('SELECT id, name, email, username, plan, created_at FROM users WHERE id = $1', [rows[0].user_id]);
  issueToken(res, rows[0].user_id, true);
  res.json({ user: publicUser(u.rows[0]) });
}));

router.delete('/account', requireAuth, authLimiter, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash))) {
    return bad(res, 'Password is incorrect', 401);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);   // ON DELETE CASCADE se sab data hat jaata hai
  clearToken(res);
  res.json({ ok: true });
}));

module.exports = router;
