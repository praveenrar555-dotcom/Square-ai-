const { pool } = require('../db');

function limitFor(plan) {
  const free = parseInt(process.env.FREE_DAILY_LIMIT || '30', 10);
  const pro = parseInt(process.env.PRO_DAILY_LIMIT || '500', 10);
  return plan === 'pro' ? pro : free;
}

// Pichhle 24 ghante (rolling) me kitne AI messages use hue
async function getUsage(user) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM usage_log WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
    [user.id]);
  return { used: rows[0].n, limit: limitFor(user.plan), plan: user.plan };
}

module.exports = { getUsage, limitFor };
