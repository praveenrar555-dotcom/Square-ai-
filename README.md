# SquareAI — Backend + Frontend (SaaS)

Node.js (Express) + PostgreSQL + Gemini API. Frontend `public/index.html` me hai, wahi server serve karta hai.

## Local chalane ke steps
```bash
npm install
cp .env.example .env      # .env me DATABASE_URL, JWT_SECRET, GEMINI_API_KEY bharo
npm start                 # http://localhost:3000
```
Tables pehli baar server start hone par apne aap ban jaate hain (`schema.sql`).

Free Postgres ke liye Neon ya Supabase use kar sakte ho; sirf connection string `DATABASE_URL` me daalo.

## Files
```
server.js            Express app, security headers, CSRF origin check, static hosting
db.js  schema.sql    Postgres pool + tables (users, conversations, messages, projects, usage_log, password_resets)
routes/auth.js       signup, signin, signout, me, profile, change password, forgot/reset, delete account
routes/data.js       bootstrap (login ke baad sab data), conversations save/delete, projects, settings, usage
routes/chat.js       POST /api/chat  -> Gemini (streaming), daily limit
services/gemini.js   Gemini REST call (API key sirf yahin use hoti hai)
services/mailer.js   Password reset email (Resend)
services/usage.js    Plan ke hisaab se daily limit
middleware/          JWT cookie auth
public/index.html    Aapka frontend (backend se jodkar)
```

## Security jo lagi hai
- Password: bcrypt (cost 12). Session: JWT httpOnly cookie (JS se padha nahi ja sakta), SameSite=Lax, production me Secure.
- **Gemini key kabhi browser me nahi jaati.** Browser sirf `/api/chat` ko call karta hai.
- Login/signup/reset par rate limit, chat par 20 msg/minute + daily plan limit.
- AI ka jawab frontend me pehle escape hota hai, phir markdown banta hai (XSS se bachav).
- Har user ka data `user_id` se alag; koi bhi query dusre user ka data nahi deti.

## Deploy (Render / Railway / Fly.io)
1. Repo push karo, Start command: `npm start`.
2. Environment variables `.env.example` ke hisaab se set karo, `NODE_ENV=production` aur `APP_URL=https://aapka-domain`.
3. HTTPS zaroori hai (cookie `Secure` hai). Ye platforms HTTPS khud dete hain.

## Frontend me kya badla
- localStorage wala demo auth/AI hataya; ab sab server se (`/api/...`).
- Chats server par auto-save (700ms debounce, tab band hone par bhi flush). Edit/regenerate/rename/star/archive/delete sab sync hote hain.
- AI jawab streaming me aata hai, markdown + code blocks + tables ke saath.
- Attachments: PNG/JPG/WebP, PDF aur text/code files Gemini ko jaati hain (max 5 files, 5MB each). `.docx` abhi supported nahi.
- Login: Enter key, error messages, Remember me, Forgot/Reset password, Change password, Delete account.
- Hataya: Google/Apple buttons (backend nahi tha), fake share link, fake 2FA toggle ("Coming soon" dikhta hai).

## Abhi nahi hai (launch se pehle sochna)
- **Payments** (plan `free`/`pro` DB me hai, par upgrade flow nahi). India ke liye Razorpay ya Stripe jod sakte ho; payment success par `users.plan='pro'` set karna hai.
- **Email verification** (abhi koi bhi email se signup ho sakta hai) — abuse rokne ke liye zaroori.
- Google/Apple login, 2FA, public share links.
- Images/files server par save nahi hote (sirf naam/size). Reload ke baad purani image dobara nahi dikhti. Iske liye S3/R2/Supabase Storage chahiye.
- Terms of Service / Privacy Policy pages (Help me abhi "(demo)" placeholder hain).
- Bootstrap abhi 300 recent chats ke saare messages ek saath load karta hai; bahut heavy users ke liye baad me lazy-loading karni hogi.
