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
    is_live      INTEGER NOT NULL DEFAULT 0,
    recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS achievements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    awarded_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, code)
  );

  CREATE TABLE IF NOT EXISTS live_devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uid  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    token       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS live_matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES pickle_sessions(id) ON DELETE CASCADE,
    match_label     INTEGER NOT NULL DEFAULT 1,
    team_a_ids      TEXT NOT NULL,
    team_b_ids      TEXT NOT NULL,
    team_a_device   INTEGER REFERENCES live_devices(id) ON DELETE SET NULL,
    team_b_device   INTEGER REFERENCES live_devices(id) ON DELETE SET NULL,
    score_a         INTEGER NOT NULL DEFAULT 0,
    score_b         INTEGER NOT NULL DEFAULT 0,
    serving_team    TEXT NOT NULL,
    server_number   INTEGER NOT NULL DEFAULT 1,
    server_slot     INTEGER NOT NULL DEFAULT 0,
    is_match_start  INTEGER NOT NULL DEFAULT 1,
    is_doubles      INTEGER NOT NULL,
    switch_acked    INTEGER NOT NULL DEFAULT 0,
    is_complete     INTEGER NOT NULL DEFAULT 0,
    match_result_id INTEGER REFERENCES match_results(id) ON DELETE SET NULL,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_event_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS live_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id     INTEGER NOT NULL REFERENCES live_matches(id) ON DELETE CASCADE,
    event_type   TEXT NOT NULL,
    team         TEXT,
    actor        TEXT NOT NULL,
    state_after  TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_pickle_sessions_status ON pickle_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id);
  CREATE INDEX IF NOT EXISTS idx_roster_session ON roster_entries(session_id);
  CREATE INDEX IF NOT EXISTS idx_match_results_session ON match_results(session_id);
  CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
  CREATE INDEX IF NOT EXISTS idx_live_matches_session ON live_matches(session_id, is_complete);
  CREATE INDEX IF NOT EXISTS idx_live_events_match ON live_events(match_id);
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
ensureColumn('match_results', 'is_live', `is_live INTEGER NOT NULL DEFAULT 0`);
ensureColumn('pickle_sessions', 'venue', `venue TEXT`);
ensureColumn('pickle_sessions', 'results_recorded', `results_recorded INTEGER NOT NULL DEFAULT 0`);
ensureColumn('roster_entries', 'is_reserve', `is_reserve INTEGER NOT NULL DEFAULT 0`);
ensureColumn('pickle_sessions', 'is_test', `is_test INTEGER NOT NULL DEFAULT 0`);

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
  // Test-session matches (is_test=1) are excluded from all stats — leaderboard,
  // win/loss totals, match history, and (transitively) achievement checks.
  const matchesAsA = db.prepare(`
    SELECT mr.*, ps.session_datetime, ps.title FROM match_results mr
    JOIN pickle_sessions ps ON ps.id = mr.session_id
    WHERE ps.is_test = 0
      AND (mr.team_a_ids LIKE ? OR mr.team_a_ids LIKE ? OR mr.team_a_ids LIKE ? OR mr.team_a_ids = ?)
  `).all(`[${userId},%`, `%,${userId},%`, `%,${userId}]`, `[${userId}]`);

  const matchesAsB = db.prepare(`
    SELECT mr.*, ps.session_datetime, ps.title FROM match_results mr
    JOIN pickle_sessions ps ON ps.id = mr.session_id
    WHERE ps.is_test = 0
      AND (mr.team_b_ids LIKE ? OR mr.team_b_ids LIKE ? OR mr.team_b_ids LIKE ? OR mr.team_b_ids = ?)
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

  const rosterCount = db.prepare(`
    SELECT COUNT(*) AS c FROM roster_entries re
    JOIN pickle_sessions ps ON ps.id = re.session_id
    WHERE re.user_id = ? AND re.is_reserve = 0 AND ps.is_test = 0
  `).get(userId).c;

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

  // Admins see everything (except cancelled/archived). Users have an extra
  // filter: hide sessions whose session_datetime is more than 12h in the past
  // — by the next morning the played session disappears from their dashboard.
  const userTimeFilter = isAdmin
    ? '1=1'
    : `datetime(ps.session_datetime) > datetime('now', 'localtime', '-12 hours')`;

  const sessions = db.prepare(`
    SELECT ps.*,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id AND r.available = 1) AS available_count,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id) AS total_responses
    FROM pickle_sessions ps
    WHERE ps.status NOT IN ('cancelled', 'archived')
      AND (ps.status != 'draft' OR ${isAdmin ? '1=1' : '1=0'})
      AND (${userTimeFilter})
      AND (${isAdmin ? '1=1' : 'ps.is_test = 0'})
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

  const VALID_TRANSITIONS = {
    draft: ['open', 'cancelled'],
    open: ['closed', 'cancelled'],
    closed: ['cancelled', 'archived'],
    cancelled: ['archived'],
    archived: ['closed']
  };
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

app.post('/api/sessions/:id/archive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!['closed', 'cancelled'].includes(session.status)) {
    return res.status(409).json({ error: 'Only closed or cancelled sessions can be archived' });
  }
  db.prepare(`UPDATE pickle_sessions SET status='archived', updated_at=datetime('now') WHERE id=?`).run(id);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/unarchive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'archived') return res.status(409).json({ error: 'Session is not archived' });
  db.prepare(`UPDATE pickle_sessions SET status='closed', updated_at=datetime('now') WHERE id=?`).run(id);
  res.json({ ok: true });
});

// Admin-only list of archived sessions (for the collapsible "Archived" section)
app.get('/api/sessions/archived', requireAdmin, (req, res) => {
  const sessions = db.prepare(`
    SELECT ps.*,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id AND r.available = 1) AS available_count,
      (SELECT COUNT(*) FROM responses r WHERE r.session_id = ps.id) AS total_responses,
      (SELECT COUNT(*) FROM match_results mr WHERE mr.session_id = ps.id) AS match_count
    FROM pickle_sessions ps
    WHERE ps.status = 'archived'
    ORDER BY ps.session_datetime DESC
  `).all();
  res.json(sessions);
});

// Re-open a session that was closed (deadline passed) so new squad members
// — or anyone who didn't get round to responding — can submit a response.
// Requires a new future response_deadline. Only allowed when the roster hasn't
// been published yet; if it has, you'd need to cancel + create a new session.
app.post('/api/sessions/:id/reopen', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'closed') {
    return res.status(409).json({ error: 'Only closed sessions can be reopened' });
  }
  if (session.roster_published === 1) {
    return res.status(409).json({ error: 'Cannot reopen — roster has been published. Cancel and create a new session instead.' });
  }

  const { response_deadline } = req.body;
  if (!response_deadline) return res.status(400).json({ error: 'response_deadline required' });
  if (new Date(response_deadline) <= new Date()) {
    return res.status(409).json({ error: 'New response deadline must be in the future' });
  }

  db.prepare(`
    UPDATE pickle_sessions
    SET status = 'open',
        response_deadline = ?,
        notified_deadline_24h = 0,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(response_deadline, id);

  // Push notification to everyone (including the new squad members)
  const label = session.title ? `${session.title} — ` : '';
  await sendPushToAll({
    title: 'McPICKLES 🥒 — Session reopened',
    body: `${label}Last chance to say if you're in. New deadline: ${formatSessionTime(response_deadline)}`,
    url: '/dashboard.html',
    tag: 'session-reopened'
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

// Create a fully-isolated test session for admin to try the live-score
// system without affecting real users, stats, league or achievements.
//   - 4 dedicated test users (idempotent: created once, reused after)
//   - status=closed, roster_published=1, is_test=1
//   - session_datetime = now + 5 min (so Live Score button is visible)
//   - any previous non-archived test session is auto-archived for tidiness
app.post('/api/admin/test-session', requireAdmin, (req, res) => {
  const ensureUser = (username, display_name, avatar) => {
    const existing = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username);
    if (existing) return existing.id;
    const r = db.prepare('INSERT INTO users (username, display_name, avatar) VALUES (?, ?, ?)').run(username, display_name, avatar);
    return r.lastInsertRowid;
  };
  const testIds = [
    ensureUser('TestA', '🧪 Test A', '🅰️'),
    ensureUser('TestB', '🧪 Test B', '🅱️'),
    ensureUser('TestC', '🧪 Test C', '©️'),
    ensureUser('TestD', '🧪 Test D', '🇩')
  ];

  // Auto-archive any previous active test session so we don't accumulate them
  db.prepare(`UPDATE pickle_sessions SET status='archived' WHERE is_test = 1 AND status != 'archived'`).run();

  // Build the new session
  const sessTime = new Date(Date.now() + 5 * 60 * 1000);
  const deadline = new Date(Date.now() - 60 * 60 * 1000); // already past
  const sessTimeStr = toLocalIsoString(sessTime);
  const deadlineStr = toLocalIsoString(deadline);

  const r = db.prepare(`
    INSERT INTO pickle_sessions
      (title, session_datetime, response_deadline, status, roster_published, is_test, max_players, courts)
    VALUES (?, ?, ?, 'closed', 1, 1, 4, 1)
  `).run('🧪 Live Score Test', sessTimeStr, deadlineStr);
  const sessionId = r.lastInsertRowid;

  // Fake the responses + roster so the live-score init code is happy
  for (const uid of testIds) {
    db.prepare('INSERT INTO responses (session_id, user_id, available, keenness) VALUES (?, ?, 1, 1)').run(sessionId, uid);
    db.prepare('INSERT INTO roster_entries (session_id, user_id, is_reserve, notified_in) VALUES (?, ?, 0, 1)').run(sessionId, uid);
  }

  res.json({
    ok: true,
    session_id: sessionId,
    live_score_url: `/score.html?session=${sessionId}`,
    test_user_ids: testIds
  });
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
  let k = null;
  if (available === 1) {
    k = parseInt(keenness);
    if (!Number.isInteger(k) || k < 1 || k > 4) {
      return res.status(400).json({ error: 'keenness must be 1-4 when available' });
    }
  }
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
        INSERT INTO match_results (session_id, match_index, team_a_ids, team_b_ids, team_a_score, team_b_score, notes, is_live)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      matchList.forEach((m, idx) => {
        if (!Array.isArray(m.team_a_ids) || !Array.isArray(m.team_b_ids)) {
          throw new Error('Each match must have team_a_ids and team_b_ids arrays');
        }
        if (!m.team_a_ids.length || !m.team_b_ids.length) {
          throw new Error('Each team must have at least one player');
        }
        if (typeof m.team_a_score !== 'number' || typeof m.team_b_score !== 'number') {
          throw new Error('Each match must have numeric scores');
        }
        insert.run(
          sid, idx,
          JSON.stringify(m.team_a_ids),
          JSON.stringify(m.team_b_ids),
          m.team_a_score, m.team_b_score,
          m.notes || null,
          m.is_live ? 1 : 0       // preserve live-saved flag if the client passes it back
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

// Append a single live-saved match (used by the live scoreboard).
// Doesn't wipe existing matches — picks the next match_index automatically.
app.post('/api/sessions/:id/results/append', requireAdmin, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM pickle_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const m = req.body;
  if (!Array.isArray(m?.team_a_ids) || !Array.isArray(m?.team_b_ids)) {
    return res.status(400).json({ error: 'team_a_ids and team_b_ids arrays required' });
  }
  if (typeof m.team_a_score !== 'number' || typeof m.team_b_score !== 'number') {
    return res.status(400).json({ error: 'Numeric team_a_score and team_b_score required' });
  }
  if (!m.team_a_ids.length || !m.team_b_ids.length) {
    return res.status(400).json({ error: 'Each team must have at least one player' });
  }

  const next = db.prepare('SELECT COALESCE(MAX(match_index), -1) + 1 AS idx FROM match_results WHERE session_id = ?').get(sessionId).idx;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO match_results (session_id, match_index, team_a_ids, team_b_ids, team_a_score, team_b_score, notes, is_live)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      sessionId, next,
      JSON.stringify(m.team_a_ids),
      JSON.stringify(m.team_b_ids),
      m.team_a_score, m.team_b_score,
      m.notes || null
    );
    db.prepare(`UPDATE pickle_sessions SET results_recorded = 1 WHERE id = ?`).run(sessionId);
  })();

  const involvedUserIds = [...new Set([...m.team_a_ids, ...m.team_b_ids])];
  checkAchievementsAfterMatch(involvedUserIds);

  res.json({ ok: true, match_index: next });
});

// ============================================================
// --- LIVE SCORING ------------------------------------------
// ============================================================
// Server-authoritative live match state, SSE for real-time
// push to all viewing clients, webhook endpoint for Flic-style
// remote buttons.
// ============================================================

const GAME_TO = 11;
const SWITCH_AT = 6;

// In-memory: SSE client registries (match_id → Set of res),
// plus a per-admin "pending sync slot" used during the team-setup
// flow before a match exists.
const matchSseClients = new Map();
const syncListening   = new Map();   // adminToken → { slot:'A'|'B', a_device, b_device, last_event_at }
const syncSseClients  = new Map();   // adminToken → Set of res

function ssePush(map, key, eventName, payload) {
  const clients = map.get(key);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try { res.write(`event: ${eventName}\ndata: ${data}\n\n`); }
    catch { /* dead connection, will be cleaned up by close handler */ }
  }
}

function hydrateMatch(row) {
  if (!row) return null;
  return {
    ...row,
    team_a_ids: JSON.parse(row.team_a_ids),
    team_b_ids: JSON.parse(row.team_b_ids),
    is_match_start: !!row.is_match_start,
    is_doubles: !!row.is_doubles,
    switch_acked: !!row.switch_acked,
    is_complete: !!row.is_complete
  };
}

function getLiveMatch(id) {
  const row = db.prepare('SELECT * FROM live_matches WHERE id = ?').get(id);
  return hydrateMatch(row);
}

function logLiveEvent(matchId, eventType, team, actor, state) {
  db.prepare(`INSERT INTO live_events (match_id, event_type, team, actor, state_after) VALUES (?, ?, ?, ?, ?)`)
    .run(matchId, eventType, team || null, actor, JSON.stringify(state));
  db.prepare(`UPDATE live_matches SET last_event_at = datetime('now') WHERE id = ?`).run(matchId);
}

// The traditional-scoring state machine (port of the client-side logic).
function applyPoint(match, rallyWinner) {
  if (match.is_complete) return match;
  if (rallyWinner !== 'A' && rallyWinner !== 'B') return match;

  if (rallyWinner === match.serving_team) {
    if (rallyWinner === 'A') match.score_a++;
    else match.score_b++;
  } else {
    if (!match.is_doubles) {
      match.serving_team = match.serving_team === 'A' ? 'B' : 'A';
      match.server_slot = 0;
      match.server_number = 1;
    } else if (match.is_match_start || match.server_number === 2) {
      match.serving_team = match.serving_team === 'A' ? 'B' : 'A';
      match.server_slot = 0;
      match.server_number = 1;
      match.is_match_start = false;
    } else {
      match.server_number = 2;
      match.server_slot = match.server_slot === 0 ? 1 : 0;
    }
  }

  // Side-switch alert state (sent in payload as a hint to the UI)
  match._switch_triggered = false;
  if (!match.switch_acked && (match.score_a >= SWITCH_AT || match.score_b >= SWITCH_AT)) {
    match.switch_acked = true;
    match._switch_triggered = true;
  }

  if ((match.score_a >= GAME_TO || match.score_b >= GAME_TO)
      && Math.abs(match.score_a - match.score_b) >= 2) {
    match.is_complete = true;
  }

  return match;
}

function persistMatchState(match) {
  db.prepare(`
    UPDATE live_matches
    SET score_a = ?, score_b = ?, serving_team = ?,
        server_number = ?, server_slot = ?, is_match_start = ?,
        switch_acked = ?, is_complete = ?
    WHERE id = ?
  `).run(
    match.score_a, match.score_b, match.serving_team,
    match.server_number, match.server_slot, match.is_match_start ? 1 : 0,
    match.switch_acked ? 1 : 0, match.is_complete ? 1 : 0,
    match.id
  );
}

function broadcastMatch(matchId, eventType = 'state', extra = {}) {
  const m = getLiveMatch(matchId);
  if (!m) return;
  ssePush(matchSseClients, matchId, eventType, { ...m, ...extra });
}

// --- Devices (one-time-per-Flic registration) ---
function newDeviceUid() { return 'flic_' + randomBytes(3).toString('hex'); }

app.get('/api/live/devices', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, device_uid, name, created_at FROM live_devices ORDER BY created_at DESC').all());
});

app.post('/api/live/devices', requireAdmin, (req, res) => {
  const name = (req.body?.name || '').trim() || 'Flic';
  const device_uid = newDeviceUid();
  const token = randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO live_devices (device_uid, name, token) VALUES (?, ?, ?)').run(device_uid, name, token);

  const host = `${req.protocol}://${req.get('host')}`;
  res.json({
    id: r.lastInsertRowid,
    device_uid,
    name,
    token,
    webhooks: {
      click: `${host}/api/live/webhook/${device_uid}?gesture=click&token=${token}`,
      hold:  `${host}/api/live/webhook/${device_uid}?gesture=hold&token=${token}`
    }
  });
});

app.delete('/api/live/devices/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM live_devices WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Pre-match sync flow (bind a Flic to a team during setup) ---
function adminToken(req) { return req.cookies?.session_token || null; }

app.post('/api/live/sync/listen', requireAdmin, (req, res) => {
  const slot = req.body?.slot;
  if (slot !== 'A' && slot !== 'B') return res.status(400).json({ error: 'slot must be A or B' });
  const tok = adminToken(req);
  const cur = syncListening.get(tok) || {};
  cur.slot = slot;
  syncListening.set(tok, cur);
  res.json({ ok: true });
});

app.post('/api/live/sync/cancel', requireAdmin, (req, res) => {
  // Cancel only clears the pending "listening for next press" slot —
  // it does NOT wipe already-bound device assignments.
  // Use /sync/reset to forget all bindings.
  const tok = adminToken(req);
  const s = syncListening.get(tok) || {};
  s.slot = null;
  syncListening.set(tok, s);
  ssePush(syncSseClients, tok, 'sync_state', { slot: null, a_device: s.a_device || null, b_device: s.b_device || null });
  res.json({ ok: true });
});

app.post('/api/live/sync/reset', requireAdmin, (req, res) => {
  syncListening.set(adminToken(req), {});
  ssePush(syncSseClients, adminToken(req), 'sync_state', { a_device: null, b_device: null, slot: null });
  res.json({ ok: true });
});

app.get('/api/live/sync/state', requireAdmin, (req, res) => {
  const s = syncListening.get(adminToken(req)) || {};
  res.json({ slot: s.slot || null, a_device: s.a_device || null, b_device: s.b_device || null });
});

app.get('/api/live/sync/stream', requireAdmin, (req, res) => {
  const tok = adminToken(req);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const s = syncListening.get(tok) || {};
  res.write(`event: sync_state\ndata: ${JSON.stringify({ slot: s.slot || null, a_device: s.a_device || null, b_device: s.b_device || null })}\n\n`);

  if (!syncSseClients.has(tok)) syncSseClients.set(tok, new Set());
  syncSseClients.get(tok).add(res);

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    syncSseClients.get(tok)?.delete(res);
  });
});

// --- Match lifecycle ---
app.post('/api/live/match/start', requireAdmin, (req, res) => {
  const { session_id, team_a_ids, team_b_ids, serving_team } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  if (!Array.isArray(team_a_ids) || !team_a_ids.length) return res.status(400).json({ error: 'team_a_ids required' });
  if (!Array.isArray(team_b_ids) || !team_b_ids.length) return res.status(400).json({ error: 'team_b_ids required' });
  if (serving_team !== 'A' && serving_team !== 'B') return res.status(400).json({ error: 'serving_team must be A or B' });

  const sess = db.prepare('SELECT id FROM pickle_sessions WHERE id = ?').get(session_id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });

  // Pull bindings from the admin's sync state (if any)
  const syncState = syncListening.get(adminToken(req)) || {};
  const a_device = syncState.a_device ? db.prepare('SELECT id FROM live_devices WHERE id = ?').get(syncState.a_device)?.id || null : null;
  const b_device = syncState.b_device ? db.prepare('SELECT id FROM live_devices WHERE id = ?').get(syncState.b_device)?.id || null : null;

  const is_doubles = team_a_ids.length === 2 && team_b_ids.length === 2 ? 1 : 0;

  // Defensive: discard any abandoned in-progress match for the same session.
  // (Normal flow always saves or discards via the win overlay, but if a user
  //  bailed out via the back button mid-game, the row would otherwise linger.)
  db.prepare(`UPDATE live_matches SET is_complete = 1 WHERE session_id = ? AND is_complete = 0`).run(session_id);

  // What match number is this in the session? Just for label.
  const prior = db.prepare('SELECT COUNT(*) AS c FROM live_matches WHERE session_id = ?').get(session_id).c;
  const matchLabel = prior + 1;

  const r = db.prepare(`
    INSERT INTO live_matches
      (session_id, match_label, team_a_ids, team_b_ids, team_a_device, team_b_device,
       serving_team, is_doubles, is_match_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    session_id, matchLabel,
    JSON.stringify(team_a_ids), JSON.stringify(team_b_ids),
    a_device, b_device,
    serving_team, is_doubles
  );

  const match = getLiveMatch(r.lastInsertRowid);
  logLiveEvent(match.id, 'start', null, 'admin', match);

  // Clear sync state after use (bindings are per-match)
  syncListening.delete(adminToken(req));

  res.json(match);
});

app.get('/api/live/match/active', requireAdmin, (req, res) => {
  const session_id = parseInt(req.query.session_id);
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const row = db.prepare(`
    SELECT * FROM live_matches
    WHERE session_id = ? AND is_complete = 0
    ORDER BY id DESC LIMIT 1
  `).get(session_id);
  res.json(hydrateMatch(row));
});

app.get('/api/live/match/:id', requireAdmin, (req, res) => {
  const m = getLiveMatch(parseInt(req.params.id));
  if (!m) return res.status(404).json({ error: 'Live match not found' });
  res.json(m);
});

app.post('/api/live/match/:id/click', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const m = getLiveMatch(id);
  if (!m) return res.status(404).json({ error: 'Live match not found' });
  if (m.is_complete) return res.status(409).json({ error: 'Match already complete' });

  const action = req.body?.action;
  if (action === 'point') {
    const team = req.body?.team;
    if (team !== 'A' && team !== 'B') return res.status(400).json({ error: 'team must be A or B' });
    const before = { ...m };
    const next = applyPoint(m, team);
    persistMatchState(next);
    logLiveEvent(id, 'point', team, req.body?.actor || 'phone', next);
    const switchTriggered = next._switch_triggered;
    broadcastMatch(id, 'state', { _switch_triggered: switchTriggered, _scored_team: team });
    res.json(getLiveMatch(id));
  } else if (action === 'undo') {
    // Find the last event for this match, restore previous state
    const events = db.prepare('SELECT * FROM live_events WHERE match_id = ? ORDER BY id DESC LIMIT 2').all(id);
    if (events.length < 2) return res.status(409).json({ error: 'Nothing to undo' });
    // events[0] = latest, events[1] = previous (the state we want to restore)
    const prevState = JSON.parse(events[1].state_after);
    persistMatchState(prevState);
    // Drop the latest event from history so subsequent undos walk further back
    db.prepare('DELETE FROM live_events WHERE id = ?').run(events[0].id);
    db.prepare(`UPDATE live_matches SET last_event_at = datetime('now') WHERE id = ?`).run(id);
    broadcastMatch(id, 'state', { _undone: true });
    res.json(getLiveMatch(id));
  } else if (action === 'switch_ack') {
    db.prepare('UPDATE live_matches SET switch_acked = 1 WHERE id = ?').run(id);
    broadcastMatch(id, 'state');
    res.json(getLiveMatch(id));
  } else {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

app.post('/api/live/match/:id/save', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const m = getLiveMatch(id);
  if (!m) return res.status(404).json({ error: 'Live match not found' });

  // Insert into match_results (with is_live = 1), pick next match_index for that session
  const nextIdx = db.prepare('SELECT COALESCE(MAX(match_index), -1) + 1 AS idx FROM match_results WHERE session_id = ?').get(m.session_id).idx;

  let resultId;
  db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO match_results (session_id, match_index, team_a_ids, team_b_ids, team_a_score, team_b_score, is_live)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      m.session_id, nextIdx,
      JSON.stringify(m.team_a_ids), JSON.stringify(m.team_b_ids),
      m.score_a, m.score_b
    );
    resultId = r.lastInsertRowid;
    db.prepare('UPDATE pickle_sessions SET results_recorded = 1 WHERE id = ?').run(m.session_id);
    db.prepare('UPDATE live_matches SET is_complete = 1, match_result_id = ? WHERE id = ?').run(resultId, id);
  })();

  const involved = [...new Set([...m.team_a_ids, ...m.team_b_ids])];
  checkAchievementsAfterMatch(involved);

  const updated = getLiveMatch(id);
  logLiveEvent(id, 'save', null, 'admin', updated);
  broadcastMatch(id, 'saved', { match_result_id: resultId });

  res.json({ ok: true, match_result_id: resultId });
});

app.post('/api/live/match/:id/discard', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const m = getLiveMatch(id);
  if (!m) return res.status(404).json({ error: 'Live match not found' });
  db.prepare('UPDATE live_matches SET is_complete = 1 WHERE id = ?').run(id);
  const updated = getLiveMatch(id);
  logLiveEvent(id, 'discard', null, 'admin', updated);
  broadcastMatch(id, 'discarded');
  res.json({ ok: true });
});

app.get('/api/live/match/:id/stream', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const m = getLiveMatch(id);
  if (!m) return res.status(404).json({ error: 'Live match not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(m)}\n\n`);

  if (!matchSseClients.has(id)) matchSseClients.set(id, new Set());
  matchSseClients.get(id).add(res);

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    matchSseClients.get(id)?.delete(res);
  });
});

// --- Flic webhook (called by the Flic app on the phone/iPad) ---
//
// Two ways the webhook is used:
// 1. During a live match: a press routes through to the bound team
//    and applies the configured gesture (click → point, hold → undo).
// 2. During pre-match sync: a press binds the pressing device to the
//    admin's pending sync slot (A or B).
//
app.post('/api/live/webhook/:uid', (req, res) => {
  const uid = req.params.uid;
  const token = req.query.token || req.body?.token;
  const gesture = (req.query.gesture || req.body?.gesture || 'click').toString();

  const device = db.prepare('SELECT * FROM live_devices WHERE device_uid = ?').get(uid);
  if (!device || device.token !== token) {
    return res.status(401).json({ error: 'Unknown device or bad token' });
  }

  // 1) Is any admin currently in sync-listen mode? If so, bind.
  for (const [adminTok, syncState] of syncListening.entries()) {
    if (syncState.slot === 'A' || syncState.slot === 'B') {
      const key = syncState.slot === 'A' ? 'a_device' : 'b_device';
      syncState[key] = device.id;
      const next = { slot: null, a_device: syncState.a_device || null, b_device: syncState.b_device || null };
      syncListening.set(adminTok, next);
      ssePush(syncSseClients, adminTok, 'synced', {
        slot: syncState.slot, device: { id: device.id, name: device.name }
      });
      ssePush(syncSseClients, adminTok, 'sync_state', next);
      return res.json({ ok: true, action: 'synced', slot: syncState.slot });
    }
  }

  // 2) Find an active match where this device is bound, and apply the gesture.
  const match = db.prepare(`
    SELECT * FROM live_matches
    WHERE is_complete = 0 AND (team_a_device = ? OR team_b_device = ?)
    ORDER BY id DESC LIMIT 1
  `).get(device.id, device.id);

  if (!match) return res.json({ ok: true, action: 'ignored', reason: 'no-active-match' });

  const team = match.team_a_device === device.id ? 'A' : 'B';

  if (gesture === 'click') {
    const m = hydrateMatch(match);
    const next = applyPoint(m, team);
    persistMatchState(next);
    logLiveEvent(match.id, 'point', team, `device:${uid}`, next);
    broadcastMatch(match.id, 'state', {
      _switch_triggered: !!next._switch_triggered,
      _scored_team: team
    });
    return res.json({ ok: true, action: 'point', team });
  }

  if (gesture === 'hold' || gesture === 'undo') {
    const events = db.prepare('SELECT * FROM live_events WHERE match_id = ? ORDER BY id DESC LIMIT 2').all(match.id);
    if (events.length < 2) return res.json({ ok: true, action: 'undo-noop' });
    const prevState = JSON.parse(events[1].state_after);
    persistMatchState(prevState);
    db.prepare('DELETE FROM live_events WHERE id = ?').run(events[0].id);
    db.prepare(`UPDATE live_matches SET last_event_at = datetime('now') WHERE id = ?`).run(match.id);
    broadcastMatch(match.id, 'state', { _undone: true });
    return res.json({ ok: true, action: 'undo' });
  }

  return res.json({ ok: true, action: 'ignored', reason: 'unknown-gesture' });
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
  // Only include players who've actually played a match — keeps the league
  // focused and avoids new squad members cluttering the bottom with 0/0/0.
  }).filter(p => p.matches_played > 0);
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
      AND ps.status NOT IN ('cancelled', 'draft', 'archived')
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
      AND ps.status NOT IN ('cancelled', 'draft', 'archived')
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

  // Also drop in-memory syncListening entries for tokens that no longer exist
  const validTokens = new Set(db.prepare('SELECT token FROM auth_sessions').all().map(r => r.token));
  let dropped = 0;
  for (const tok of syncListening.keys()) {
    if (!validTokens.has(tok)) { syncListening.delete(tok); dropped++; }
  }
  if (dropped > 0) console.log(`[cron] Dropped ${dropped} orphaned syncListening entries`);
}, { timezone: 'Europe/London' });

app.listen(PORT, () => console.log(`McPICKLES running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`));
