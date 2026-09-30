require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { init: initDb, pool } = require('./db');

// ---- Required env check ----
const missing = ['DATABASE_URL', 'JWT_SECRET'].filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
if (process.env.JWT_SECRET.length < 32) { console.error('JWT_SECRET must be at least 32 characters'); process.exit(1); }
if (!process.env.GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY set nahi hai. Chat kaam nahi karegi.');

const isProd = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', 1);            // Render/Railway/Vercel/Nginx ke peeche sahi client IP ke liye
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Frontend single-file hai (inline script/onclick handlers), isliye 'unsafe-inline' chahiye.
      // Model output frontend me escape hokar hi render hota hai (XSS se bachav wahin hai).
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));
app.use(cookieParser());

// CSRF ka extra layer: browser Origin header apni site se alag ho to state-changing request block
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let allowed;
  try {
    allowed = process.env.APP_URL ? new URL(process.env.APP_URL).host : req.get('host');
    if (new URL(origin).host === allowed) return next();
  } catch {}
  return res.status(403).json({ error: 'Forbidden' });
}
app.use('/api', sameOrigin);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// chat ka apna bada JSON limit hai, isliye global json parser se PEHLE mount
app.use('/api/chat', require('./routes/chat'));

app.use('/api', express.json({ limit: '5mb' }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/data'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// Central error handler
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

(async () => {
  await initDb();
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = app.listen(port, () => console.log(`SquareAI running on http://localhost:${port}`));
  // Graceful shutdown
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
