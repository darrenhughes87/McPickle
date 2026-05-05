# McPICKLES — Deployment Guide

From zero to live at `mcpickles.pivotalsl.co.uk`. Step by step.

---

## Before You Start — What You Need

- A GitHub account
- SSH access to the Hostinger VPS (`ssh root@187.77.177.208`)
- Access to your DNS provider (Hostinger or wherever the domain is registered)
- The McPICKLES project folder on your Mac

---

## Step 1 — Push to GitHub

Do this on your Mac.

### 1a. Create the GitHub repo

Go to [github.com/new](https://github.com/new) and create a new **private** repo called `mcpickles`. Don't tick "Add README" — leave it empty.

### 1b. Initialise git in the project folder

Open Terminal, navigate to the project:

```bash
cd "/Users/pivotalsl/Documents/Claude/Projects/McPickles"
```

Run these commands one at a time:

```bash
git init
git add .
git commit -m "Initial commit — McPICKLES PWA"
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USERNAME/mcpickles.git
git push -u origin main
```

> Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

**Check it worked:** go to your repo on GitHub and you should see all the files there — but NOT the `.env` file (it's in `.gitignore`).

---

## Step 2 — Point the DNS

Do this before starting the container on the VPS. Let's Encrypt needs DNS to point at the server before it can issue the SSL certificate.

### 2a. Log into your DNS provider

Wherever the domain `pivotalsl.co.uk` is registered (Hostinger or similar).

### 2b. Add an A record

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | mcpickles | 187.77.177.208 | Automatic |

The **Name** is `mcpickles` (not the full domain — just the subdomain part).

### 2c. Wait for DNS to propagate

This can take a few minutes or up to an hour. Check it's live with:

```bash
dig +short mcpickles.pivotalsl.co.uk @8.8.8.8
```

When it returns `187.77.177.208`, you're good to go. Don't move to Step 4 until this works.

---

## Step 3 — Set Up the VPS

SSH into the VPS from your Mac:

```bash
ssh root@187.77.177.208
```

### 3a. Create the app folder

```bash
mkdir -p /docker/mcpickles
cd /docker/mcpickles
```

### 3b. Clone the repo

```bash
git clone git@github.com:YOUR_GITHUB_USERNAME/mcpickles.git .
```

> The `.` at the end means "clone into the current folder" — don't miss it.

If you get a permission error, you need to add your VPS's SSH key to GitHub. Run `cat ~/.ssh/id_rsa.pub` on the VPS, then add it at [github.com/settings/keys](https://github.com/settings/keys).

### 3c. Generate VAPID keys

These are needed for push notifications. Run this on the VPS:

```bash
node -e "import('web-push').then(m => { const k = m.default.generateVAPIDKeys(); console.log('PUBLIC:', k.publicKey); console.log('PRIVATE:', k.privateKey); })"
```

Copy both keys — you'll need them in the next step.

> If `node` isn't found on the VPS, you don't need it — you can generate the keys on your Mac (they're just static values) and paste them in.

To generate on your Mac instead:

```bash
cd "/Users/pivotalsl/Documents/Claude/Projects/McPickles"
node -e "import('web-push').then(m => { const k = m.default.generateVAPIDKeys(); console.log('PUBLIC:', k.publicKey); console.log('PRIVATE:', k.privateKey); })"
```

### 3d. Create the `.env` file on the VPS

```bash
nano /docker/mcpickles/.env
```

Paste this in, filling in the values:

```
PORT=3003
ADMIN_PASSWORD=your_strong_password_here

VAPID_PUBLIC_KEY=paste_your_public_key_here
VAPID_PRIVATE_KEY=paste_your_private_key_here
VAPID_CONTACT_EMAIL=admin@mcpickles.pivotalsl.co.uk
```

Save with `Ctrl+O`, Enter, then `Ctrl+X` to exit.

> **Pick a real password** for `ADMIN_PASSWORD` — not `changeme`. This is the password you'll use to log into the admin dashboard.

---

## Step 4 — Start the App

Still on the VPS, in `/docker/mcpickles/`:

```bash
docker compose up -d --build
```

This will:
- Build the Docker image from the `Dockerfile`
- Start the container
- Register it with Traefik, which will automatically request an SSL certificate from Let's Encrypt

First build takes about a minute. Watch it go with:

```bash
docker logs mcpickles -f
```

You should see: `McPICKLES running on port 3003`

Press `Ctrl+C` to stop watching the logs (the app keeps running).

---

## Step 5 — Verify It's Live

### 5a. Check the container is running

```bash
docker ps
```

You should see `mcpickles` in the list with status `Up`.

### 5b. Open the app

Go to [https://mcpickles.pivotalsl.co.uk](https://mcpickles.pivotalsl.co.uk) in your browser.

You should see the user login page. If you get a certificate warning, give it another minute for Let's Encrypt to issue the cert.

### 5c. Log into the admin panel

Go to [https://mcpickles.pivotalsl.co.uk/admin.html](https://mcpickles.pivotalsl.co.uk/admin.html)

Enter the `ADMIN_PASSWORD` you set in the `.env` file.

### 5d. Create your player account

In the admin dashboard → Squad tab:
- Create a user for yourself, e.g. display name `Darren`, username `DarrenH`, toggle Priority on
- This is your playing account — log into it at the main login page in another tab

---

## What's in the App

- **Sessions**: admin posts slots, players respond Yes/No + keenness, admin picks roster
- **Reserves**: roster has main + reserve list; if a player drops out, the first reserve auto-promotes (push-notified)
- **Match results**: admin records scores after a session — singles or doubles
- **Stats / League**: per-player wins/losses/win-rate, squad leaderboard ordered by wins
- **Achievements**: 12 unlockables (first match, win streaks, super keen, reliable, etc.)
- **Profile**: each player picks an emoji avatar and can change their display name
- **Push notifications**: session published, you're in, 24h reminder, 1h reminder, achievement unlocked, reserve promoted, session cancelled
- **Pickle facts**: a random tidbit at the top of the dashboard for fun
- **PWA**: installable on iOS / Android home screen, works offline for static assets

## Updating the App Later

When you make changes on your Mac and want to push them live:

**On your Mac:**
```bash
cd "/Users/pivotalsl/Documents/Claude/Projects/McPickles"
git add .
git commit -m "describe what you changed"
git push
```

**On the VPS:**
```bash
cd /docker/mcpickles
git pull
docker compose up -d --build
```

That's it. The database (SQLite) is stored in a Docker volume (`mcpickles_data`) so it survives rebuilds.

---

## Useful Commands (on the VPS)

```bash
# See app logs live
docker logs mcpickles -f

# Restart the app without rebuilding
docker compose restart mcpickles

# Stop the app
docker compose down

# Check disk usage (SQLite data)
docker exec mcpickles du -sh /app/data/

# Check all running containers
docker ps
```

---

## Troubleshooting

**"502 Bad Gateway" in browser**
The container isn't running or is still starting. Check `docker ps` and `docker logs mcpickles`.

**SSL cert not working / certificate warning**
DNS probably hadn't propagated yet when you first started the container. Fix:
```bash
docker compose down
docker compose up -d
```
Traefik will retry the cert request.

**Can't clone the repo ("Permission denied")**
The VPS SSH key isn't added to GitHub. Run `cat ~/.ssh/id_rsa.pub` on the VPS and add it at github.com/settings/keys.

**Forgot the admin password**
Edit `/docker/mcpickles/.env` on the VPS, change `ADMIN_PASSWORD`, then restart:
```bash
docker compose restart mcpickles
```

**App crashes on startup**
Missing env var. Check the logs: `docker logs mcpickles`. The server prints exactly which var is missing.
