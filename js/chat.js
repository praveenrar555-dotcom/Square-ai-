const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getUsage } = require('../services/usage');
const { streamChat, GeminiError } = require('../services/gemini');

const router = express.Router();

const MODELS = new Set(['smart', 'fast', 'reasoning', 'coding']);
const MAX_MESSAGES = 40;              // itni purani history hi Gemini ko bhejte hain
const MAX_TEXT = 30000;               // ek message ka max text
const MAX_FILE_TEXT = 200000;         // text file ka max size (chars)
const MAX_INLINE_BYTES = 12 * 1024 * 1024;   // saare images/pdf ka total (decoded)
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

const perMinute = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many messages. Please slow down.' }
});

function badRequest(res, msg) { return res.status(400).json({ error: msg }); }

// Client ka payload -> Gemini "contents". Validation yahin hoti hai.
function buildContents(messages) {
  let inlineBytes = 0;
  const contents = [];

  // Naye messages se peeche jaakar attachments ka budget gino, taaki purane attachments pehle drop hon
  const keepAttachments = new Array(messages.length).fill(null);
  for (let i = messages.length - 1; i >= 0; i--) {
    const atts = Array.isArray(messages[i].attachments) ? messages[i].attachments.slice(0, 5) : [];
    const kept = [];
    for (const a of atts) {
      if (!a || typeof a !== 'object') continue;
      if (typeof a.textContent === 'string' && a.textContent) {
        kept.push({ kind: 'text', name: String(a.name || 'file').slice(0, 120), text: a.textContent.slice(0, MAX_FILE_TEXT) });
      } else if (typeof a.dataUrl === 'string') {
        const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(a.dataUrl);
        if (!m || !INLINE_MIME.has(m[1])) continue;
        const bytes = Math.floor(m[2].length * 0.75);
        if (inlineBytes + bytes > MAX_INLINE_BYTES) continue;
        inlineBytes += bytes;
        kept.push({ kind: 'inline', mime: m[1], data: m[2] });
      }
    }
    keepAttachments[i] = kept;
  }

  messages.forEach((m, i) => {
    const parts = [];
    for (const a of keepAttachments[i]) {
      if (a.kind === 'text') parts.push({ text: `[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\`` });
      else parts.push({ inlineData: { mimeType: a.mime, data: a.data } });
    }
    parts.push({ text: m.text });
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  });

  // Gemini history user message se shuru honi chahiye
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

router.post('/', express.json({ limit: '16mb' }), requireAuth, perMinute, async (req, res, next) => {
  let logId = null;
  try {
    const { model, messages } = req.body || {};
    if (!MODELS.has(model)) return badRequest(res, 'Invalid model');
    if (!Array.isArray(messages) || messages.length === 0) return badRequest(res, 'No messages');

    const clean = [];
    for (const m of messages.slice(-MAX_MESSAGES)) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') {
        return badRequest(res, 'Invalid message');
      }
      const text = m.text.slice(0, MAX_TEXT);
      if (!text.trim()) continue;
      clean.push({ role: m.role, text, attachments: m.attachments });
    }
    if (!clean.length || clean[clean.length - 1].role !== 'user') return badRequest(res, 'Last message must be from the user');

    const contents = buildContents(clean);

    // Daily limit check + usage log (parallel requests se bachne ke liye pehle insert)
    const usage = await getUsage(req.user);
    if (usage.used >= usage.limit) {
      return res.status(429).json({
        error: `Daily limit reached (${usage.limit} messages on the ${usage.plan} plan). Try again later or upgrade.`,
        code: 'LIMIT'
      });
    }
    const ins = await pool.query('INSERT INTO usage_log (user_id, model) VALUES ($1, $2) RETURNING id', [req.user.id, model]);
    logId = ins.rows[0].id;

    // SSE stream shuru
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });   // user tab band kare to Gemini call rok do
    const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    // Long responses me proxy idle timeout se bachne ke liye heartbeat
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

    try {
      await streamChat({ modelKey: model, contents, signal: controller.signal, onText: (t) => send({ t }) });
      send({ done: true, usage: { used: usage.used + 1, limit: usage.limit, plan: usage.plan } });
    } catch (e) {
      if (controller.signal.aborted) {
        // client chala gaya, kuch nahi karna
      } else {
        if (!(e instanceof GeminiError)) console.error('[chat] unexpected', e);
        send({ error: (e instanceof GeminiError && e.userMessage) || 'Something went wrong. Please try again.' });
        // Kuch bhi output nahi mila to user ka message count wapas kar do
        if (logId) { await pool.query('DELETE FROM usage_log WHERE id = $1', [logId]).catch(() => {}); logId = null; }
      }
    } finally {
      clearInterval(beat);
      res.end();
    }
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    next(e);
  }
});

module.exports = router;
