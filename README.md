# POS with MongoDB Atlas

1. In Atlas: create a free cluster, a database user, and allow your IP (Network Access).
2. `cp .env.example .env` and fill in `MONGODB_URI` and a long random `JWT_SECRET`.
3. `npm install` then `npm start`, and open http://localhost:3000
4. Register your company (this creates the admin), then add cashiers/managers from Settings > Users.

Deploy to Render/Railway/Fly: set the same env vars there and use `npm start`.
Data is loaded at login and refreshed every 30 seconds so several devices stay roughly in sync.

## Deploy on Netlify
Push to GitHub, then Netlify > Add new site > Import from Git. `netlify.toml` sets everything up.
Add `MONGODB_URI` and `JWT_SECRET` under Site configuration > Environment variables, then deploy.
In Atlas > Network Access allow `0.0.0.0/0`.

## Backup on Render (same code, same database)
Both Netlify and Render run this project and talk to the same Atlas database, so data is identical on both.
If Netlify is paused or out of credits, just open the Render address instead.

1. Push this project (with `render.yaml`) to GitHub.
2. Render > New > Blueprint > pick the repository (or New > Web Service with build `npm install`, start `npm start`).
3. When asked, enter `MONGODB_URI` (same as Netlify) and `JWT_SECRET` (any long random string).
4. Deploy, then open `https://<name>.onrender.com/api/health`. You want `{"server":"ok","database":"connected"}`.

Notes
- Render's free plan sleeps after 15 minutes idle; the first visit afterwards can take about 30 seconds.
- Log in again on the Render address (browsers keep logins separately per website address).
- Atlas > Network Access must allow `0.0.0.0/0`.

## New in this version
- **Returns & refunds** (Reports > Refund), **expenses**, **stock history & adjustments**, **low stock list**, **audit log**.
- **Export to CSV, full backup and restore** (Settings > Backup & export, admin only).
- **Hold a sale** (Cart > Hold / Held).
- **Works offline**: install the site to the home screen. Sales, stock and other records made without internet are saved on the device and sent automatically when the connection returns.
- **Password reset**: users change their own password; admins reset anyone's; a forgotten password is reset with the **recovery code** shown once at registration (admins can make a new one in Settings).

Redeploy BOTH `server.js` and `public/` (index.html, sw.js, manifest.webmanifest, icon.svg).
Existing companies have no recovery code yet: log in as admin, open Settings and tap **Recovery code**.
