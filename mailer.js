// Password reset email. Resend (resend.com) use kiya hai kyunki sirf ek HTTP call chahiye.
// RESEND_API_KEY aur MAIL_FROM set nahi hain to link server console me print hoga (development ke liye).
async function sendMail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    console.warn('[mailer] RESEND_API_KEY/MAIL_FROM set nahi hai. Email nahi bheji gayi. Content:\n' + text);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, text })
  });
  if (!res.ok) {
    console.error('[mailer] send failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}

module.exports = { sendMail };
