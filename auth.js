const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const COOKIE = 'sq_token';
const DAY = 24 * 60 * 60 * 1000;

function cookieOpts(remember) {
  const o = {
    httpOnly: true,                                  // JS se token read nahi hoga (XSS se safe)
    sameSite: 'lax',                                 // cross-site POST me cookie nahi jaati (CSRF)
    secure: process.env.NODE_ENV === 'production',   // production me sirf HTTPS
    path: '/'
  };
  if (remember) o.maxAge = 30 * DAY;                 // remember nahi => session cookie (browser band = logout)
  return o;
}

function issueToken(res, userId, remember = true) {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: remember ? '30d' : '1d' });
  res.cookie(COOKIE, token, cookieOpts(remember));
}

function clearToken(res) {
  res.clearCookie(COOKIE, cookieOpts(false));
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Please sign in' });
    const { sub } = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, name, email, username, plan, created_at FROM users WHERE id = $1', [sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Please sign in' });
    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

module.exports = { issueToken, clearToken, requireAuth };
