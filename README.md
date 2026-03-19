# 🐍 Snake & Ladder v2 — Real-time Multiplayer

Full-stack game with **WebSocket sync** — all players see the same board in real time.

## Architecture
- **Frontend**: `frontend/index.html` → GitHub Pages
- **Backend**: `backend/server.js` → Render.com (Node + Socket.IO)
- **Database**: MongoDB Atlas (free)

---

## STEP 1 — MongoDB Atlas (2 min)
1. https://cloud.mongodb.com → Free cluster (M0)
2. Database Access → Add User → `snl_user` + strong password
3. Network Access → Allow `0.0.0.0/0`
4. Connect → Drivers → copy URI: `mongodb+srv://snl_user:PASS@cluster.xxx.mongodb.net/snl_game`

---

## STEP 2 — GitHub Repo (2 min)
```bash
git init
git add .
git commit -m "Snake & Ladder v2"
git remote add origin https://github.com/YOU/snake-ladder.git
git push -u origin main
```

---

## STEP 3 — Render.com Backend (5 min)
1. https://render.com → New Web Service → connect your repo
2. Settings:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance: **Free**
3. Environment Variables:
   | Key | Value |
   |-----|-------|
   | MONGODB_URI | your Atlas URI |
   | JWT_SECRET | any 64-char random string |
   | ADMIN_USERNAME | your secret admin username |
   | ADMIN_PASSWORD | YourPassword@123! |
4. Deploy → get URL like `https://snl-abc123.onrender.com`

---

## STEP 4 — Update Frontend (1 min)
In `frontend/index.html`, line ~750:
```js
const SERVER = 'https://snl-abc123.onrender.com';  // ← your Render URL
```

Commit & push to GitHub.

---

## STEP 5 — GitHub Pages (2 min)
1. Repo Settings → Pages → Deploy from branch `main`
2. Folder: `/frontend` (or move `index.html` to root)
3. Live at: `https://YOU.github.io/snake-ladder`

---

## How Multiplayer Works
- Player A: Creates room → gets 6-char code
- Player B/C/D/E: Enter code → joins room
- Host clicks Start → **all devices get `game_started` via WebSocket**
- Each player can **only roll on their own turn** — server enforces this
- All dice rolls and moves are broadcast to **all connected clients simultaneously**
- Board state is **canonical on the server** — no desync possible

## ⚠️ Render Free Tier
- Spins down after 15 min idle → first request takes ~30s to wake up
- Upgrade to Starter ($7/mo) to keep it always-on

## Admin
- Login with ADMIN_USERNAME + ADMIN_PASSWORD
- Admin button appears on home screen
- Dashboard: Users / Games / Active Rooms / Leaderboard
