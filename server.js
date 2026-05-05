import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import cron from 'node-cron';
import cookieParser from 'cookie-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3003;
const IS_PROD = process.env.NODE_ENV === 'production';

// --- Env validation ---
const required = ['ADMIN_PASSWORD', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_CONTACT_EMAIL'];
for (const key of required) {
  if (!process.env[key]) { console.error(`Missing env var: ${key}`); process.exit(1); }
}

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_CONTACT_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// --- Database ---
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/app/data' : join(__dirname, 'data'));
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, 'mcpickles.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    is_priority  INTEGER NOT NULL DEFAULT 0,
    push_sub     TEXT,
    avatar       TEXT NOT NULL DEFAULT '🥒',
    availability TEXT,
    onboarded_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pickle_sessions (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    title                      TEXT,
    session_datetime           TEXT NOT NULL,
    max_players                INTEGER NOT NULL DEFAULT 4,
    courts                     INTEGER NOT NULL DEFAULT 1,
    court_cost_per_court_pence INTEGER NOT NULL DEFAULT 600,
    racket_hire_pence          INTEGER NOT NULL DEFAULT 250,
    response_deadline          TEXT NOT NULL,
    status                     TEXT NOT NULL DEFAULT 'draft',
    roster_published           INTEGER NOT NULL DEFAULT 0,
    notes                      TEXT,
    notified_open              INTEGER NOT NULL DEFAULT 0,
    notified_deadline_24h      INTEGER NOT NULL DEFAULT 0,
    venue                      TEXT,
    results_recorded           INTEGER NOT NULL DEFAULT 0,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS responses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES pickle_sessions(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    available    INTEGER NOT NULL,
    keenness     INTEGER,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS roster_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES pickle_sessions(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_reserve   INTEGER NOT NULL DEFAULT 0,
    notified_in  INTEGER NOT NULL DEFAULT 0,
    notified_24h INTEGER NOT NULL DEFAULT 0,
    notified_1h  INTEGER NOT NULL DEFAULT 0,
    added_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS match_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES pickle_sessions(id) ON DELETE CASCADE,
    match_index  INTEGER NOT NULL DEFAULT 0,
    team_a_ids   TEXT NOT NULL,
    team_b_ids   TEXT NOT NULL,
    team_a_score INTEGER NOT NULL,
    team_b_score INTEGER NOT NULL,
    notes        TEXT,
    recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS achievements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    awarded_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, code)
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_pickle_sessions_status ON pickle_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id);
  CREATE INDEX IF NOT EXISTS idx_roster_session ON roster_entries(session_id);
  CREATE INDEX IF NOT EXISTS idx_match_results_session ON match_results(session_id);
  CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
`);

// --- Migrations for older databases ---
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrate] Added ${table}.${column}`);
  }
}
ensureColumn('users', 'avatar', `avatar TEXT NOT NULL DEFAULT '🥒'`);
ensureColumn('users', 'availability', `availability TEXT`);
ensureColumn('users', 'onboarded_at', `onboarded_at TEXT`);
ensureColumn('pickle_sessions', 'notified_deadline_24h', `notified_deadline_24h INTEGER NOT NULL DEFAULT 0`);
ensureColumn('pickle_sessions', 'venue', `venue TEXT`);
ensureColumn('pickle_sessions', 'results_recorded', `results_recorded INTEGER NOT NULL DEFAULT 0`);
ensureColumn('roster_entries', 'is_reserve', `is_reserve INTEGER NOT NULL DEFAULT 0`);

// --- Helpers ---
const PICKLE_FACTS = [
  "Pickleball was invented in 1965 on Bainbridge Island, Washington.",
  "The sport got its name from the inventor's dog, Pickles, who chased the balls.",
  "A pickleball court is the same size as a doubles badminton court.",
  "The 'kitchen' is the no-volley zone within 7 feet of the net.",
  "Pickleball is one of the fastest-growing sports in the world.",
  "A pickleball has 26 to 40 round holes — fewer for outdoor play.",
  "The longest recorded pickleball rally lasted over 16,000 shots.",
  "You can't volley from inside the kitchen — but you can stand there.",
  "Games are typically played to 11, win by 2.",
  "Only the serving team can score points in traditional rules.",
  "The serve must be underhand and made below the waist.",
  "Pickleball paddles are smaller than tennis rackets but bigger than ping pong paddles.",
  "Joel Pritchard, a Washington state congressman, co-invented the game.",
  "The first permanent pickleball court was built in 1967 in Pritchard's backyard.",
  "Pickleball became Washington's official state sport in 2022.",
  "Drinking a pickle juice shot before a match is a real pickleball superstition.",
  "Pickleball burns roughly 350-700 calories per hour.",
  "The 'Erne' shot is named after Erne Perry, who pioneered the move.",
  "A 'dink' is a soft shot that arcs over the net into the kitchen.",
  "Saying 'nice shot' to your opponent is part of pickleball etiquette."
];

function generateToken() {
  return randomBytes(32).toString('hex');
}

const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const USER_SESSION_MS  = 60 * 24 * 60 * 60 * 1000;  // 60 days

function createAuthSession(userId, isAdmin) {
  const token = generateToken();
  const durationMs = isAdmin ? ADMIN_SESSION_MS : USER_SESSION_MS;
  const expiresAt = new Date(Date.now() + durationMs).toISOString().replace('Z', '').slice(0, 19);
  db.prepare(`INSERT INTO auth_sessions (token, user_id, is_admin, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId ?? null, isAdmin ? 1 : 0, expiresAt);
  return token;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toLocalIsoString(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function calcDefaultDeadline(sessionDatetimeStr) {
  const d = new Date(sessionDatetimeStr);
  const jsDay = d.getDay();
  const dayFromMonday = jsDay === 0 ? 6 : jsDay - 1;
  const thisMonday = new Date(d);
  thisMonday.setDate(d.getDate() - dayFromMonday);
  const prevFriday = new Date(thisMonday);
  prevFriday.setDate(thisMonday.getDate() - 3);
  prevFriday.setHours(23, 59, 59, 0);
  return toLocalIsoString(prevFriday);
}

function calcCost(session, playerCount) {
  const courtTotal = session.courts * session.court_cost_per_court_pence;
  const perPlayer = playerCount > 0 ? Math.ceil(courtTotal / playerCount) : 0;
  return {
    court_total_pence: courtTotal,
    cost_per_player_pence: perPlayer,
    racket_hire_pence: session.racket_hire_pence
  };
}

function suggestByKeenness(responses, maxPlayers) {
  const available = responses.filter(r => r.available === 1);
  available.sort((a, b) => {
    if (b.is_priority !== a.is_priority) return b.is_priority - a.is_priority;
    if (a.keenness !== b.keenness) return a.keenness - b.keenness;
    return new Date(a.submitted_at) - new Date(b.submitted_at);
  });
  return available.slice(0, maxPlayers).map(r => r.user_id);
}

function suggestRandom(responses, maxPlayers) {
  const available = responses.filter(r => r.available === 1);
  const priority = available.filter(r => r.is_priority === 1);
  const rest = available.filter(r => r.is_priority === 0);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...priority, ...rest].slice(0, maxPlayers).map(r => r.user_id);
}

async function sendPushToUser(userId, payload) {
  const user = db.prepare('SELECT push_sub FROM users WHERE id = ?').get(userId);
  if (!user?.push_sub) return false;
  try {
    await webpush.sendNotification(JSON.parse(user.push_sub), JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      db.prepare('UPDATE users SET push_sub = NULL WHERE id = ?').run(userId);
    } else {
      console.error(`Push failed for user ${userId}:`, err.message);
    }
    return false;
  }
}

async function sendPushToAll(payload) {
  const users = db.prepare('SELECT id FROM users WHERE push_sub IS NOT NULL').all();
  for (const u of users) await sendPushToUser(u.id, payload);
}

function formatSessionTime(dt) {
  try {
    return new Date(dt).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
    });
  } catch { return dt; }
}

// --- Achievements ---
const ACHIEVEMENT_CATALOG = {
  welcome_aboard: { emoji: '🎉', name: 'Welcome Aboard',  desc: 'Joined the squad' },
  first_match:    { emoji: '🥒', name: 'First Pickle',    desc: 'Played your first match' },
  ten_matches:    { emoji: '🏓', name: 'Regular',         desc: 'Played 10 matches' },
  first_win:      { emoji: '🥇', name: 'First Win',       desc: 'Won your first match' },
  win_streak_3:   { emoji: '🔥', name: 'Hat-Trick',       desc: 'Won 3 matches in a row' },
  win_streak_5:   { emoji: '⚡', name: 'On Fire',         desc: 'Won 5 matches in a row' },
  always_keen:    { emoji: '😤', name: 'Always Keen',     desc: 'Said yes 5 times running' },
  super_keen:     { emoji: '🔥', name: 'Super Keen',      desc: 'Picked "Extremely Keen" 5 times' },
  reliable:       { emoji: '⭐', name: 'Reliable',        desc: 'Responded to 10 sessions' },
  early_bird:     { emoji: '🐦', name: 'Early Bird',      desc: 'First to respond 3 times' },
  reserve_hero:   { emoji: '🦸', name: 'Reserve Hero',    desc: 'Promoted from reserve to playing' },
  perfect_score:  { emoji: '💯', name: 'Perfect Score',   desc: 'Won a match 11-0' }
};

function award(userId, code) {
  if (!ACHIEVEMENT_CATALOG[code]) return false;
  const result = db.prepare(`INSERT OR IGNORE INTO achievements (user_id, code) VALUES (?, ?)`).run(userId, code);
  if (result.changes > 0) {
    const a = ACHIEVEMENT_CATALOG[code];
    sendPushToUser(userId, {
      title: `${a.emoji} Achievement Unlocked!`,
      body: `${a.name} — ${a.desc}`,
      url: '/dashboard.html#stats',
      tag: `achievement-${code}`
    }).catch(() => {});
    return true;
  }
  return false;
}

function getPlayerStats(userId) {
  const matchesAsA = db.prepare(`
    SELECT mr.*, ps.session_datetime, ps.title FROM match_results mr
    JOIN pickle_sessions ps ON ps.id = mr.session_id
    WHERE mr.team_a_ids LIKE ? OR mr.team_a_ids LIKE ? OR mr.team_a_ids LIKE ? OR mr.team_a_ids = ?
  `).all(`[${userId},%`, `%,${userId},%`, `%,${userId}]`, `[${userId}]`);

  const matchesAsB = db.prepare(`
    SELECT mr.*, ps.session_datetime, ps.title FROM match_results mr
    JOIN pickle_sessions ps ON ps.id = mr.session_id
    WHERE mr.team_b_ids LIKE ? OR mr.team_b_ids LIKE ? OR mr.team_b_ids LIKE ? OR mr.team_b_ids = ?
  `).all(`[${userId},%`, `%,${userId},%`, `%,${userId}]`, `[${userId}]`);

  let wins = 0, losses = 0;
  const allMatches = [];
  for (const m of matchesAsA) {
    const won = m.team_a_score > m.team_b_score;
    if (won) wins++; else losses++;
    allMatches.push({ ...m, was_team_a: true, won });
  }
  for (const m of matchesAsB) {
    const won = m.team_b_score > m.team_a_score;
    if (won) wins++; else losses++;
    allMatches.push({ ...m, was_team_a: false, won });
  }

  const responses = db.prepare(`SELECT available FROM responses WHERE user_id = ?`).all(userId);
  const yesCount = responses.filter(r => r.available === 1).length;

  const rosterCount = db.prepare(`SELECT COUNT(*) AS c FROM roster_entries WHERE user_id = ? AND is_reserve = 0`).get(userId).c;

  return {
    matches_played: wins + losses,
    wins,
    losses,
    win_rate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
    sessions_attended: rosterCount,
    response_count: responses.length,
    yes_count: yesCount,
    yes_rate: responses.length > 0 ? Math.round((yesCount / responses.length) * 100) : 0,
    matches: allMatches.sort((a, b) => new Date(b.session_datetime) - new Date(a.session_datetime))
  };
}

function checkAchievementsAfterMatch(userIds) {
  for (const uid of userIds) {
    const stats = getPlayerStats(uid);
    if (stats.matches_played >= 1) award(uid, 'first_match');
    if (stats.matches_played >= 10) award(uid, 'ten_matches');
    if (stats.wins >= 1) award(uid, 'first_win');

    // Win streaks
    let streak = 0;
    for (const m of stats.matches) {
      if (m.won) streak++;
      else break;
    }
    if (streak >= 3) award(uid, 'win_streak_3');
    if (streak >= 5) award(uid, 'win_streak_5');

    // Perfect score
    const perfectMatch = stats.matches.find(m =>
      (m.was_team_a && m.team_a_score === 11 && m.team_b_score === 0) ||
      (!m.was_team_a && m.team_b_score === 11 && m.team_a_score === 0)
    );
    if (perfectMatch) award(uid, 'perfect_score');
  }
}

function checkResponseAchievements(userId) {
  const responses = db.prepare(`SELECT available, keenness FROM responses WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 5`).all(userId);
  if (responses.length >= 5 && responses.every(r => r.available === 1)) award(userId, 'always_keen');
  if (responses.length >= 5 && responses.every(r => r.keenness === 1)) award(userId, 'super_keen');

  const totalResponses = db.prepare(`SELECT COUNT(*) AS c FROM responses WHERE user_id = ?`).get(userId).c;
  if (totalResponses >= 10) award(userId, 'reliable');
}

// --- Express setup ---
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, 'public')));

// Cookies: secure only in prod (so http://localhost works in dev)
// maxAge is in milliseconds (Express converts to Max-Age seconds in the header)
function cookieOpts(isAdmin) {
  return {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    path: '/',
    maxAge: isAdmin ? ADMIN_SESSION_MS : USER_SESSION_MS
  };
}

// --- Auth middleware ---
function requireUser(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const session = db.prepare(`
    SELECT s.is_admin, s.user_id,
           u.id AS uid, u.username, u.display_name, u.is_priority, u.avatar,
           u.availability, u.onboarded_at
    FROM auth_sessions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);

  if (!session) return res.status(401).json({ error: 'Session expired or invalid' });

  if (session.is_admin) {
    req.adminSession = true;
    req.user = { is_admin: 1 };
  } else {
    req.user = {
      id: session.uid,
      username: session.username,
      display_name: session.display_name,
      is_priority: session.is_priority,
      avatar: session.avatar,
      availability: session.availability ? JSON.parse(session.availability) : null,
      onboarded_at: session.onboarded_at,
      is_admin: 0
    };
  }
  next();
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.adminSession) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// --- Routes: Health ---
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Routes: Auth ---
app.post('/api/auth/admin-login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = createAuthSession(null, true);
  res.cookie('session_token', token, cookieOpts(true));
  res.json({ ok: true });
});

app.post('/api/auth/user-login', (req, res) => {
  const { username } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'Username required' });

  const user = db.prepare(`SELECT * FROM users WHERE lower(username) = lower(?)`).get(username.trim());
  if (!user) return res.status(401).json({ error: 'Username not found. Ask Darren to add you to the squad!' });

  const token = createAuthSession(user.id, false);
  res.cookie('session_token', token, cookieOpts(false));
  // Welcome achievement (idempotent, only fires the first time)
  award(user.id, 'welcome_aboard');
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      is_priority: user.is_priority,
      avatar: user.avatar,
      availability: user.availability ? JSON.parse(user.availability) : null,
      onboarded_at: user.onboarded_at
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  res.clearCookie('session_token', { httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireUser, (req, res) => {
  if (req.adminSession) return res.json({ admin: true });
  res.json({ user: req.user });
});

// --- Routes: Pickle Fact (no auth - public fun) ---
app.get('/api/fact', (req, res) => {
  const fact = PICKLE_FACTS[Math.floor(Math.random() * PICKLE_FACTS.length)];
  res.json({ fact });
});

// --- Routes: Users ---
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT id, username, display_name, is_priority, avatar, availability, onboarded_at, created_at FROM users ORDER BY display_name`).all();
  res.json(users.map(u => ({ ...u, availability: u.availability ? JSON.parse(u.availability) : null })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, display_name, is_priority = 0, avatar = '🥒' } = req.body;
  if (!username?.trim() || !display_name?.trim()) return res.status(400).json({ error: 'username and display_name required' });

  try {
    const result = db.prepare(`INSERT INTO users (username, display_name, is_priority, avatar) VALUES (?, ?, ?, ?)`)
      .run(username.trim(), display_name.trim(), is_priority ? 1 : 0, avatar);
    res.json({ id: result.lastInsertRowid, username: username.trim(), display_name: display_name.trim(), is_priority: is_priority ? 1 : 0, avatar });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    throw err;
  }
});

app.patch('/api/users/:id', requireUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.adminSession && req.user.id !== id) return res.status(403).json({ error: 'Forbidden' });

  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { display_name, is_priority, avatar, username, availability, onboarded } = req.body;
  if (display_name !== undefined) {
    if (!display_name.trim()) return res.status(400).json({ error: 'Display name cannot be empty' });
    db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(display_name.trim(), id);
  }
  if (username !== undefined) {
    const trimmed = username.trim();
    if (!trimmed) return res.status(400).json({ error: 'Username cannot be empty' });
    if (/\s/.test(trimmed)) return res.status(400).json({ error: 'Username cannot contain spaces' });
    const conflict = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?').get(trimmed, id);
    if (conflict) return res.status(409).json({ error: 'Username already taken' });
    db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(trimmed, id);
  }
  if (avatar !== undefined) db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(avatar, id);
  if (availability !== undefined) {
    const json = availability ? JSON.stringify(availability) : null;
    db.prepare(`UPDATE users SET availability = ? WHERE id = ?`).run(json, id);
  }
  if (onboarded === true) {
    db.prepare(`UPDATE users SET onboarded_at = COALESCE(onboarded_at, datetime('now')) WHERE id = ?`).run(id);
  }
  // Only admin can flip priority
  if (is_priority !== undefined && req.adminSession) {
    db.prepare(`UPDATE users SET is_priority = ? WHERE id = ?`).run(is_priority ? 1 : 0, id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.adminSession && req.user.id !== id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Routes: Push ---
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireUser, (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin cannot subscribe to push' });
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription required' });
  db.prepare('UPDATE users SET push_sub = ? WHERE id = ?').run(JSON.stringify(subscription), req.user.id);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireUser, (req, res) => {
  if (!req.adminSession) db.prepare('UPDATE users SET push_sub = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.post('/api/push/test', requireUser, async (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin has no push subscription' });
  const user = db.prepare('SELECT push_sub FROM users WHERE id = ?').get(req.user.id);
  if (!user?.push_sub) {
    return res.json({ ok: true, sent: false, reason: 'no-subscription' });
  }
  try {
    await webpush.sendNotification(JSON.parse(user.push_sub), JSON.stringify({
      title: 'McPICKLES 🥒 — Test',
      body: 'Push notifications are working!',
      url: '/dashboard.html',
      tag: 'test'
    }));
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error(`[push test] user ${req.user.id} failed:`, err.statusCode, err.body || err.message);
    if (err.statusCode === 410 || err.statusCode === 404) {
      db.prepare('UPDATE users SET push_sub = NULL WHERE id = ?').run(req.user.id);
    }
    res.json({
      ok: true,
      sent: false,
      reason: 'push-rejected',
      statusCode: err.statusCode,
      detail: (err.body || err.message || '').toString().slice(0, 300)
    });
  }
});

// --- Routes: Pickle Sessions ---
app.get('/api/sessions', requireUser, (req, res) => {
  const isAdmin = req.adminSession;
  const userId = req.user?.id;

  const sessions = db.prepare(`
    SELECT ps.*,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id AND r.available = 1) AS available_count,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id) AS total_responses
    FROM pickle_sessions ps
    WHERE ps.status NOT IN ('cancelled') AND (ps.status != 'draft' OR ${isAdmin ? '1=1' : '1=0'})
    ORDER BY ps.session_datetime ASC
  `).all();

  const result = sessions.map(s => {
    let my_response = null;
    if (!isAdmin && userId) {
      const r = db.prepare(`SELECT available, keenness FROM responses WHERE session_id = ? AND user_id = ?`).get(s.id, userId);
      if (r) my_response = r;
    }

    let roster_info = null;
    if (s.roster_published && !isAdmin && userId) {
      const myEntry = db.prepare(`SELECT is_reserve FROM roster_entries WHERE session_id = ? AND user_id = ?`).get(s.id, userId);
      if (myEntry) {
        const players = db.prepare(`
          SELECT u.id, u.display_name, u.avatar FROM roster_entries re
          JOIN users u ON u.id = re.user_id
          WHERE re.session_id = ? AND re.is_reserve = 0
          ORDER BY u.display_name
        `).all(s.id);
        const reserves = db.prepare(`
          SELECT u.id, u.display_name, u.avatar FROM roster_entries re
          JOIN users u ON u.id = re.user_id
          WHERE re.session_id = ? AND re.is_reserve = 1
          ORDER BY re.added_at
        `).all(s.id);
        roster_info = {
          on_roster: myEntry.is_reserve === 0,
          on_reserve: myEntry.is_reserve === 1,
          players,
          reserves,
          ...calcCost(s, players.length)
        };
      }
    }

    return { ...s, available_count: s.available_count, total_responses: s.total_responses, my_response, roster_info };
  });

  res.json(result);
});

app.post('/api/sessions', requireAdmin, (req, res) => {
  const {
    session_datetime, title = null, max_players = 4, courts = 1,
    court_cost_per_court_pence = 600, racket_hire_pence = 250,
    response_deadline, notes = null, venue = null
  } = req.body;

  if (!session_datetime) return res.status(400).json({ error: 'session_datetime required' });

  const deadline = response_deadline || calcDefaultDeadline(session_datetime);
  const result = db.prepare(`
    INSERT INTO pickle_sessions
      (title, session_datetime, max_players, courts, court_cost_per_court_pence, racket_hire_pence, response_deadline, notes, venue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, session_datetime, max_players, courts, court_cost_per_court_pence, racket_hire_pence, deadline, notes, venue);

  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(result.lastInsertRowid);
  res.json(session);
});

// Clone session (admin)
app.post('/api/sessions/:id/clone', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const src = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!src) return res.status(404).json({ error: 'Source session not found' });

  // Default to one week later
  const newDt = new Date(src.session_datetime);
  newDt.setDate(newDt.getDate() + 7);
  const newDtStr = toLocalIsoString(newDt);
  const newDeadline = calcDefaultDeadline(newDtStr);

  const result = db.prepare(`
    INSERT INTO pickle_sessions
      (title, session_datetime, max_players, courts, court_cost_per_court_pence, racket_hire_pence, response_deadline, notes, venue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(src.title, newDtStr, src.max_players, src.courts, src.court_cost_per_court_pence, src.racket_hire_pence, newDeadline, src.notes, src.venue);

  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(result.lastInsertRowid);
  res.json(session);
});

app.patch('/api/sessions/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.status === 'cancelled') {
    return res.status(409).json({ error: 'Cannot modify a cancelled session' });
  }

  const VALID_TRANSITIONS = { draft: ['open', 'cancelled'], open: ['closed', 'cancelled'], closed: ['cancelled'] };
  if (req.body.status !== undefined && req.body.status !== session.status) {
    const allowed = VALID_TRANSITIONS[session.status] || [];
    if (!allowed.includes(req.body.status)) {
      return res.status(409).json({ error: `Cannot transition from '${session.status}' to '${req.body.status}'` });
    }
  }

  const fields = ['title', 'session_datetime', 'max_players', 'courts', 'court_cost_per_court_pence',
                  'racket_hire_pence', 'response_deadline', 'notes', 'status', 'venue'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  updates.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE pickle_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/publish', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'draft') return res.status(409).json({ error: 'Session must be in draft to publish' });
  if (new Date(session.response_deadline) <= new Date()) {
    return res.status(409).json({ error: 'Response deadline is already in the past — update it before publishing' });
  }

  db.prepare(`UPDATE pickle_sessions SET status='open', notified_open=1, updated_at=datetime('now') WHERE id=?`).run(id);

  const label = session.title ? `${session.title} — ` : '';
  await sendPushToAll({
    title: 'McPICKLES 🥒',
    body: `${label}${formatSessionTime(session.session_datetime)} is on! Are you in?`,
    url: '/dashboard.html',
    tag: 'session-open'
  });

  res.json({ ok: true });
});

app.post('/api/sessions/:id/cancel', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled' });

  const wasPublished = session.roster_published === 1;
  db.prepare(`UPDATE pickle_sessions SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(id);

  if (wasPublished) {
    const roster = db.prepare('SELECT user_id FROM roster_entries WHERE session_id = ?').all(id);
    const label = session.title ? `${session.title} — ` : '';
    for (const entry of roster) {
      await sendPushToUser(entry.user_id, {
        title: 'McPICKLES 🥒 — Session Cancelled',
        body: `${label}${formatSessionTime(session.session_datetime)} has been cancelled. Sorry!`,
        url: '/dashboard.html',
        tag: 'session-cancelled'
      });
    }
  }
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT status FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'draft') return res.status(409).json({ error: 'Only draft sessions can be deleted' });
  db.prepare('DELETE FROM pickle_sessions WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Routes: Responses ---
app.post('/api/sessions/:id/respond', requireUser, (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin cannot respond to sessions' });

  const sessionId = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'open') return res.status(409).json({ error: 'Session is not accepting responses' });

  const now = new Date();
  const deadline = new Date(session.response_deadline);
  if (now > deadline) return res.status(409).json({ error: 'Response deadline has passed' });

  const { available, keenness } = req.body;
  if (available !== 0 && available !== 1) return res.status(400).json({ error: 'available must be 0 or 1' });
  if (available === 1 && (keenness < 1 || keenness > 4)) {
    return res.status(400).json({ error: 'keenness must be 1-4 when available' });
  }

  const k = available === 1 ? (parseInt(keenness) || null) : null;
  db.prepare(`
    INSERT INTO responses (session_id, user_id, available, keenness, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(session_id, user_id) DO UPDATE SET
      available = excluded.available,
      keenness = excluded.keenness,
      updated_at = datetime('now')
  `).run(sessionId, req.user.id, available, k);

  // Check for early-bird achievement
  const respondedCount = db.prepare(`SELECT COUNT(*) AS c FROM responses WHERE session_id = ?`).get(sessionId).c;
  if (respondedCount === 1) {
    const earlyBirdCount = db.prepare(`
      SELECT COUNT(*) AS c FROM responses r
      WHERE r.user_id = ? AND r.submitted_at = (
        SELECT MIN(submitted_at) FROM responses WHERE session_id = r.session_id
      )
    `).get(req.user.id).c;
    if (earlyBirdCount >= 3) award(req.user.id, 'early_bird');
  }

  checkResponseAchievements(req.user.id);

  res.json({ ok: true });
});

app.delete('/api/sessions/:id/respond', requireUser, (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin cannot delete responses' });
  db.prepare('DELETE FROM responses WHERE session_id = ? AND user_id = ?').run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// --- Routes: Roster ---
app.get('/api/sessions/:id/responses', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const responses = db.prepare(`
    SELECT r.user_id, r.available, r.keenness, r.submitted_at, r.updated_at,
           u.username, u.display_name, u.is_priority, u.avatar, u.availability
    FROM responses r
    JOIN users u ON u.id = r.user_id
    WHERE r.session_id = ?
    ORDER BY r.submitted_at ASC
  `).all(id);

  responses.forEach(r => { r.availability = r.availability ? JSON.parse(r.availability) : null; });

  const allUsers = db.prepare('SELECT id, username, display_name, is_priority, avatar, availability FROM users ORDER BY display_name').all();
  allUsers.forEach(u => { u.availability = u.availability ? JSON.parse(u.availability) : null; });
  const respondedIds = new Set(responses.map(r => r.user_id));
  const nonResponders = allUsers.filter(u => !respondedIds.has(u.id));

  const suggestions = {
    by_keenness: suggestByKeenness(responses, session.max_players),
    random: suggestRandom(responses, session.max_players)
  };

  const rosterRows = db.prepare('SELECT user_id, is_reserve FROM roster_entries WHERE session_id = ?').all(id);
  const currentRoster = rosterRows.filter(r => r.is_reserve === 0).map(r => r.user_id);
  const currentReserves = rosterRows.filter(r => r.is_reserve === 1).map(r => r.user_id);
  const confirmedCount = currentRoster.length || responses.filter(r => r.available === 1).length;

  res.json({
    session,
    responses,
    non_responders: nonResponders,
    current_roster: currentRoster,
    current_reserves: currentReserves,
    suggestions,
    cost_info: calcCost(session, Math.min(confirmedCount, session.max_players))
  });
});

app.post('/api/sessions/:id/roster', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.roster_published === 1) return res.status(409).json({ error: 'Roster already published — cannot modify' });

  const { user_ids, reserve_ids = [] } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids array required' });

  try {
    const saveRoster = db.transaction((sessionId, ids, reserves) => {
      db.prepare('DELETE FROM roster_entries WHERE session_id = ?').run(sessionId);
      const insert = db.prepare('INSERT INTO roster_entries (session_id, user_id, is_reserve) VALUES (?, ?, ?)');
      for (const uid of ids) insert.run(sessionId, uid, 0);
      for (const uid of reserves) {
        if (!ids.includes(uid)) insert.run(sessionId, uid, 1);
      }
    });
    saveRoster(id, user_ids, reserve_ids);
  } catch (err) {
    if (err.message.includes('FOREIGN KEY')) return res.status(422).json({ error: 'One or more user IDs do not exist' });
    throw err;
  }

  res.json({ ok: true });
});

app.post('/api/sessions/:id/roster/publish', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.roster_published === 1) return res.status(409).json({ error: 'Roster already published' });
  if (!['open', 'closed'].includes(session.status)) {
    return res.status(409).json({ error: 'Session must be open or closed before publishing roster' });
  }

  const roster = db.prepare('SELECT user_id, is_reserve FROM roster_entries WHERE session_id = ?').all(id);
  if (!roster.filter(r => r.is_reserve === 0).length) return res.status(400).json({ error: 'No players on roster yet' });

  db.prepare(`UPDATE pickle_sessions SET roster_published=1, updated_at=datetime('now') WHERE id=?`).run(id);

  const label = session.title ? `${session.title} — ` : '';
  for (const entry of roster) {
    db.prepare('UPDATE roster_entries SET notified_in=1 WHERE session_id=? AND user_id=?').run(id, entry.user_id);
    if (entry.is_reserve === 0) {
      await sendPushToUser(entry.user_id, {
        title: "McPICKLES 🥒 — You're in!",
        body: `${label}You've been selected for ${formatSessionTime(session.session_datetime)}. Get your paddle ready!`,
        url: '/dashboard.html',
        tag: 'roster-published'
      });
    } else {
      await sendPushToUser(entry.user_id, {
        title: "McPICKLES 🥒 — On standby",
        body: `${label}You're on the reserve list for ${formatSessionTime(session.session_datetime)}. We'll let you know if a spot opens up.`,
        url: '/dashboard.html',
        tag: 'reserve'
      });
    }
  }

  res.json({ ok: true });
});

// Promote a reserve to the main roster (admin)
app.post('/api/sessions/:id/roster/promote', requireAdmin, async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = db.prepare('SELECT * FROM roster_entries WHERE session_id = ? AND user_id = ?').get(sessionId, user_id);
  if (!entry) return res.status(404).json({ error: 'User not on roster or reserves' });
  if (entry.is_reserve === 0) return res.status(409).json({ error: 'User is already in main roster' });

  db.prepare('UPDATE roster_entries SET is_reserve = 0 WHERE session_id = ? AND user_id = ?').run(sessionId, user_id);

  award(user_id, 'reserve_hero');

  const label = session.title ? `${session.title} — ` : '';
  await sendPushToUser(user_id, {
    title: "McPICKLES 🦸 — You're in!",
    body: `${label}A spot opened up — you're playing ${formatSessionTime(session.session_datetime)}!`,
    url: '/dashboard.html',
    tag: 'reserve-promoted'
  });

  res.json({ ok: true });
});

// Drop self from roster (user)
app.post('/api/sessions/:id/dropout', requireUser, async (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin cannot drop out' });
  const sessionId = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entry = db.prepare('SELECT * FROM roster_entries WHERE session_id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!entry) return res.status(404).json({ error: 'You are not on the roster' });

  db.prepare('DELETE FROM roster_entries WHERE session_id = ? AND user_id = ?').run(sessionId, req.user.id);

  // Auto-promote first reserve if dropout was from main roster
  let promoted = null;
  if (entry.is_reserve === 0) {
    const firstReserve = db.prepare(`
      SELECT user_id FROM roster_entries
      WHERE session_id = ? AND is_reserve = 1
      ORDER BY added_at ASC LIMIT 1
    `).get(sessionId);
    if (firstReserve) {
      db.prepare('UPDATE roster_entries SET is_reserve = 0 WHERE session_id = ? AND user_id = ?').run(sessionId, firstReserve.user_id);
      promoted = firstReserve.user_id;
      award(firstReserve.user_id, 'reserve_hero');
      const label = session.title ? `${session.title} — ` : '';
      await sendPushToUser(firstReserve.user_id, {
        title: "McPICKLES 🦸 — You're in!",
        body: `${label}A spot opened up — you're playing ${formatSessionTime(session.session_datetime)}!`,
        url: '/dashboard.html',
        tag: 'reserve-promoted'
      });
    }

    // Notify admin? Just log for now
    console.log(`[dropout] User ${req.user.display_name} dropped from session ${sessionId}${promoted ? `, promoted ${promoted}` : ''}`);
  }

  res.json({ ok: true, promoted });
});

app.get('/api/sessions/:id/roster', requireUser, (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Use /api/sessions/:id/responses for admin' });

  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.roster_published) return res.json({ visible: false });

  const onRoster = db.prepare('SELECT is_reserve FROM roster_entries WHERE session_id = ? AND user_id = ?').get(id, req.user.id);
  if (!onRoster) return res.json({ visible: false });

  const players = db.prepare(`
    SELECT u.id, u.display_name, u.avatar FROM roster_entries re
    JOIN users u ON u.id = re.user_id
    WHERE re.session_id = ? AND re.is_reserve = 0 ORDER BY u.display_name
  `).all(id);
  const reserves = db.prepare(`
    SELECT u.id, u.display_name, u.avatar FROM roster_entries re
    JOIN users u ON u.id = re.user_id
    WHERE re.session_id = ? AND re.is_reserve = 1 ORDER BY re.added_at
  `).all(id);

  res.json({
    visible: true,
    players,
    reserves,
    on_reserve: onRoster.is_reserve === 1,
    ...calcCost(session, players.length)
  });
});

// --- Routes: Match Results ---
app.get('/api/sessions/:id/results', requireUser, (req, res) => {
  const id = parseInt(req.params.id);
  const results = db.prepare(`
    SELECT mr.*, ps.title, ps.session_datetime
    FROM match_results mr
    JOIN pickle_sessions ps ON ps.id = mr.session_id
    WHERE mr.session_id = ?
    ORDER BY mr.match_index ASC
  `).all(id);

  const enriched = results.map(r => ({
    ...r,
    team_a_ids: JSON.parse(r.team_a_ids),
    team_b_ids: JSON.parse(r.team_b_ids)
  }));

  // Hydrate with display names
  const allUserIds = [...new Set(enriched.flatMap(r => [...r.team_a_ids, ...r.team_b_ids]))];
  const users = allUserIds.length > 0
    ? db.prepare(`SELECT id, display_name, avatar FROM users WHERE id IN (${allUserIds.map(() => '?').join(',')})`).all(...allUserIds)
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  enriched.forEach(r => {
    r.team_a = r.team_a_ids.map(uid => userMap[uid] || { id: uid, display_name: 'Unknown', avatar: '❓' });
    r.team_b = r.team_b_ids.map(uid => userMap[uid] || { id: uid, display_name: 'Unknown', avatar: '❓' });
  });

  res.json(enriched);
});

app.post('/api/sessions/:id/results', requireAdmin, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { matches } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'matches array required' });

  const allInvolvedUserIds = new Set();

  try {
    const saveResults = db.transaction((sid, matchList) => {
      db.prepare('DELETE FROM match_results WHERE session_id = ?').run(sid);
      const insert = db.prepare(`
        INSERT INTO match_results (session_id, match_index, team_a_ids, team_b_ids, team_a_score, team_b_score, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      matchList.forEach((m, idx) => {
        if (!Array.isArray(m.team_a_ids) || !Array.isArray(m.team_b_ids)) {
          throw new Error('Each match must have team_a_ids and team_b_ids arrays');
        }
        if (typeof m.team_a_score !== 'number' || typeof m.team_b_score !== 'number') {
          throw new Error('Each match must have numeric scores');
        }
        insert.run(
          sid, idx,
          JSON.stringify(m.team_a_ids),
          JSON.stringify(m.team_b_ids),
          m.team_a_score, m.team_b_score,
          m.notes || null
        );
        m.team_a_ids.forEach(uid => allInvolvedUserIds.add(uid));
        m.team_b_ids.forEach(uid => allInvolvedUserIds.add(uid));
      });
      db.prepare('UPDATE pickle_sessions SET results_recorded = ? WHERE id = ?').run(matchList.length > 0 ? 1 : 0, sid);
    });
    saveResults(sessionId, matches);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Award achievements (after transaction commits)
  checkAchievementsAfterMatch([...allInvolvedUserIds]);

  res.json({ ok: true });
});

// --- Routes: Stats / Leaderboard ---
app.get('/api/stats/me', requireUser, (req, res) => {
  if (req.adminSession) return res.status(403).json({ error: 'Admin has no player stats' });
  const stats = getPlayerStats(req.user.id);
  const userAchievements = db.prepare('SELECT code, awarded_at FROM achievements WHERE user_id = ? ORDER BY awarded_at DESC').all(req.user.id);
  res.json({
    user: req.user,
    stats,
    achievements: userAchievements.map(a => ({ ...a, ...ACHIEVEMENT_CATALOG[a.code] })),
    catalog: ACHIEVEMENT_CATALOG
  });
});

app.get('/api/stats/leaderboard', requireUser, (req, res) => {
  const users = db.prepare(`SELECT id, display_name, avatar, is_priority FROM users ORDER BY display_name`).all();
  const board = users.map(u => {
    const stats = getPlayerStats(u.id);
    return {
      ...u,
      matches_played: stats.matches_played,
      wins: stats.wins,
      losses: stats.losses,
      win_rate: stats.win_rate,
      sessions_attended: stats.sessions_attended,
      yes_rate: stats.yes_rate
    };
  });
  // Sort by wins desc, then win_rate desc
  board.sort((a, b) => b.wins - a.wins || b.win_rate - a.win_rate || b.matches_played - a.matches_played);
  res.json(board);
});

app.get('/api/stats/user/:id', requireUser, (req, res) => {
  const id = parseInt(req.params.id);
  const user = db.prepare('SELECT id, display_name, avatar, is_priority, created_at FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const stats = getPlayerStats(id);
  const userAchievements = db.prepare('SELECT code, awarded_at FROM achievements WHERE user_id = ? ORDER BY awarded_at DESC').all(id);
  res.json({
    user,
    stats,
    achievements: userAchievements.map(a => ({ ...a, ...ACHIEVEMENT_CATALOG[a.code] })),
    catalog: ACHIEVEMENT_CATALOG
  });
});

// --- Page guards ---
app.get('/admin-dash.html', (req, res, next) => {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect('/admin.html');
  const session = db.prepare(`SELECT is_admin FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')`).get(token);
  if (!session?.is_admin) return res.redirect('/admin.html');
  next();
});

app.get('/dashboard.html', (req, res, next) => {
  const token = req.cookies?.session_token;
  if (!token) return res.redirect('/');
  const session = db.prepare(`SELECT is_admin, user_id FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')`).get(token);
  if (!session) return res.redirect('/');
  if (session.is_admin) return res.redirect('/admin-dash.html');
  next();
});

// --- Cron jobs ---
async function runCronTasks() {
  // 1. Auto-close sessions past deadline
  const closed = db.prepare(`
    UPDATE pickle_sessions SET status='closed', updated_at=datetime('now')
    WHERE status='open' AND datetime(response_deadline) < datetime('now', 'localtime')
  `).run();
  if (closed.changes > 0) console.log(`[cron] Auto-closed ${closed.changes} session(s)`);

  // 1b. Deadline-approaching reminder: 24h before deadline, ping non-responders
  const deadlineSoon = db.prepare(`
    SELECT id, title, session_datetime, response_deadline
    FROM pickle_sessions
    WHERE status='open'
      AND notified_deadline_24h = 0
      AND datetime(response_deadline) <= datetime('now', 'localtime', '+24 hours')
      AND datetime(response_deadline) > datetime('now', 'localtime')
  `).all();

  for (const s of deadlineSoon) {
    db.prepare(`UPDATE pickle_sessions SET notified_deadline_24h=1 WHERE id=?`).run(s.id);
    const nonResponders = db.prepare(`
      SELECT u.id FROM users u
      WHERE u.push_sub IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.session_id = ? AND r.user_id = u.id)
    `).all(s.id);
    const label = s.title ? `${s.title} — ` : '';
    for (const u of nonResponders) {
      await sendPushToUser(u.id, {
        title: 'McPICKLES ⏳ — 1 day left',
        body: `${label}${formatSessionTime(s.session_datetime)} — last chance to say if you're in!`,
        url: '/dashboard.html',
        tag: 'deadline-24h'
      });
    }
    if (nonResponders.length) console.log(`[cron] Deadline-24h reminder sent to ${nonResponders.length} for session ${s.id}`);
  }

  // 2. 24-hour reminders
  const remind24 = db.prepare(`
    SELECT re.session_id, re.user_id, ps.title, ps.session_datetime
    FROM roster_entries re
    JOIN pickle_sessions ps ON ps.id = re.session_id
    WHERE ps.roster_published = 1
      AND ps.status NOT IN ('cancelled', 'draft')
      AND re.is_reserve = 0
      AND re.notified_24h = 0
      AND datetime(ps.session_datetime) <= datetime('now', 'localtime', '+24 hours')
      AND datetime(ps.session_datetime) > datetime('now', 'localtime')
  `).all();

  for (const r of remind24) {
    db.prepare('UPDATE roster_entries SET notified_24h=1 WHERE session_id=? AND user_id=?').run(r.session_id, r.user_id);
    const label = r.title ? `${r.title} — ` : '';
    await sendPushToUser(r.user_id, {
      title: 'McPICKLES 🥒 — Tomorrow!',
      body: `${label}You're playing tomorrow at ${formatSessionTime(r.session_datetime)}. See you on the court!`,
      url: '/dashboard.html',
      tag: 'reminder-24h'
    });
  }

  // 3. 1-hour reminders
  const remind1h = db.prepare(`
    SELECT re.session_id, re.user_id, ps.title, ps.session_datetime
    FROM roster_entries re
    JOIN pickle_sessions ps ON ps.id = re.session_id
    WHERE ps.roster_published = 1
      AND ps.status NOT IN ('cancelled', 'draft')
      AND re.is_reserve = 0
      AND re.notified_1h = 0
      AND datetime(ps.session_datetime) <= datetime('now', 'localtime', '+1 hour')
      AND datetime(ps.session_datetime) > datetime('now', 'localtime')
  `).all();

  for (const r of remind1h) {
    db.prepare('UPDATE roster_entries SET notified_1h=1 WHERE session_id=? AND user_id=?').run(r.session_id, r.user_id);
    const label = r.title ? `${r.title} — ` : '';
    await sendPushToUser(r.user_id, {
      title: 'McPICKLES 🥒 — Court time!',
      body: `${label}You're on the court in about an hour. Warm up those knees!`,
      url: '/dashboard.html',
      tag: 'reminder-1h'
    });
  }
}

cron.schedule('* * * * *', () => { runCronTasks().catch(console.error); }, { timezone: 'Europe/London' });

// Nightly auth_sessions cleanup
cron.schedule('0 3 * * *', () => {
  const result = db.prepare(`DELETE FROM auth_sessions WHERE expires_at < datetime('now')`).run();
  if (result.changes > 0) console.log(`[cron] Cleaned up ${result.changes} expired session(s)`);
}, { timezone: 'Europe/London' });

app.listen(PORT, () => console.log(`McPICKLES running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`));
