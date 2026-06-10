/* ════════════════════════════════════════════════════════════════
   db.js  —  Base de données SQLite locale (better-sqlite3)
   Candidats, évaluations, commentaires, utilisateurs, sessions,
   commissions et paramètres.
   ════════════════════════════════════════════════════════════════ */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "evaluations.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nom       TEXT NOT NULL,
    prenom    TEXT NOT NULL,
    numero    TEXT DEFAULT '',
    excelPath TEXT DEFAULT NULL,
    excelName TEXT DEFAULT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    candidateId INTEGER NOT NULL,
    sheet       TEXT NOT NULL,        -- 'STAGE','R1','R2','R3','SO'
    itemId      TEXT NOT NULL,        -- id d'un sous-critère (feuille)
    checked     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (candidateId, sheet, itemId),
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    candidateId INTEGER NOT NULL,
    sheet       TEXT NOT NULL,
    text        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (candidateId, sheet),
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,       -- format: salt:hashHex (scrypt)
    displayName  TEXT NOT NULL DEFAULT '',
    role         TEXT NOT NULL CHECK (role IN ('admin','teacher','commission')),
    createdAt    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token     TEXT PRIMARY KEY,
    userId    INTEGER NOT NULL,
    createdAt TEXT DEFAULT (datetime('now')),
    expiresAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS commissions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commission_members (
    commissionId INTEGER NOT NULL,
    userId       INTEGER NOT NULL,
    PRIMARY KEY (commissionId, userId),
    FOREIGN KEY (commissionId) REFERENCES commissions(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS commission_candidates (
    commissionId INTEGER NOT NULL,
    candidateId  INTEGER NOT NULL,
    PRIMARY KEY (commissionId, candidateId),
    FOREIGN KEY (commissionId) REFERENCES commissions(id) ON DELETE CASCADE,
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

const q = {
  // ── Candidats ──
  listCandidates:  db.prepare("SELECT * FROM candidates ORDER BY nom, prenom"),
  listCandidatesForUser: db.prepare(`
    SELECT DISTINCT c.* FROM candidates c
    JOIN commission_candidates cc ON cc.candidateId = c.id
    JOIN commission_members cm ON cm.commissionId = cc.commissionId
    WHERE cm.userId = ? ORDER BY c.nom, c.prenom
  `),
  getCandidate:    db.prepare("SELECT * FROM candidates WHERE id = ?"),
  addCandidate:    db.prepare("INSERT INTO candidates (nom, prenom, numero) VALUES (?, ?, ?)"),
  updateCandidate: db.prepare("UPDATE candidates SET nom = ?, prenom = ?, numero = ? WHERE id = ?"),
  setExcel:        db.prepare("UPDATE candidates SET excelPath = ?, excelName = ? WHERE id = ?"),
  deleteCandidate: db.prepare("DELETE FROM candidates WHERE id = ?"),

  // ── Évaluations ──
  getEval: db.prepare("SELECT itemId, checked FROM evaluations WHERE candidateId = ? AND sheet = ?"),
  setEval: db.prepare(`
    INSERT INTO evaluations (candidateId, sheet, itemId, checked)
    VALUES (@candidateId, @sheet, @itemId, @checked)
    ON CONFLICT(candidateId, sheet, itemId) DO UPDATE SET checked = @checked
  `),

  // ── Commentaires ──
  getComment: db.prepare("SELECT text FROM comments WHERE candidateId = ? AND sheet = ?"),
  setComment: db.prepare(`
    INSERT INTO comments (candidateId, sheet, text) VALUES (?, ?, ?)
    ON CONFLICT(candidateId, sheet) DO UPDATE SET text = excluded.text
  `),

  // ── Utilisateurs ──
  listUsers:   db.prepare("SELECT id, username, displayName, role, createdAt FROM users ORDER BY username"),
  getUser:     db.prepare("SELECT * FROM users WHERE id = ?"),
  getUserByName: db.prepare("SELECT * FROM users WHERE username = ?"),
  addUser:     db.prepare("INSERT INTO users (username, passwordHash, displayName, role) VALUES (?, ?, ?, ?)"),
  updateUserPassword: db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?"),
  deleteUser:  db.prepare("DELETE FROM users WHERE id = ?"),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),

  // ── Sessions ──
  addSession:    db.prepare("INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)"),
  getSession:    db.prepare(`
    SELECT s.token, s.expiresAt, u.id AS userId, u.username, u.displayName, u.role
    FROM sessions s JOIN users u ON u.id = s.userId
    WHERE s.token = ? AND s.expiresAt > datetime('now')
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expiresAt <= datetime('now')"),

  // ── Commissions ──
  listCommissions: db.prepare("SELECT * FROM commissions ORDER BY name"),
  getCommission:   db.prepare("SELECT * FROM commissions WHERE id = ?"),
  addCommission:   db.prepare("INSERT INTO commissions (name) VALUES (?)"),
  renameCommission:db.prepare("UPDATE commissions SET name = ? WHERE id = ?"),
  deleteCommission:db.prepare("DELETE FROM commissions WHERE id = ?"),
  commissionMembers: db.prepare(`
    SELECT u.id, u.username, u.displayName, u.role FROM commission_members cm
    JOIN users u ON u.id = cm.userId WHERE cm.commissionId = ?
  `),
  commissionCandidates: db.prepare(`
    SELECT c.id, c.nom, c.prenom FROM commission_candidates cc
    JOIN candidates c ON c.id = cc.candidateId WHERE cc.commissionId = ?
  `),
  addMember:       db.prepare("INSERT OR IGNORE INTO commission_members (commissionId, userId) VALUES (?, ?)"),
  removeMember:    db.prepare("DELETE FROM commission_members WHERE commissionId = ? AND userId = ?"),
  addCommCandidate:db.prepare("INSERT OR IGNORE INTO commission_candidates (commissionId, candidateId) VALUES (?, ?)"),
  removeCommCandidate: db.prepare("DELETE FROM commission_candidates WHERE commissionId = ? AND candidateId = ?"),
  userCanSeeCandidate: db.prepare(`
    SELECT 1 FROM commission_candidates cc
    JOIN commission_members cm ON cm.commissionId = cc.commissionId
    WHERE cm.userId = ? AND cc.candidateId = ? LIMIT 1
  `),

  // ── Paramètres ──
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};

module.exports = {
  db,

  // Candidats
  listCandidates: () => q.listCandidates.all(),
  listCandidatesForUser: (userId) => q.listCandidatesForUser.all(userId),
  getCandidate: (id) => q.getCandidate.get(id),
  addCandidate: (nom, prenom, numero) => {
    const info = q.addCandidate.run(nom.trim(), prenom.trim(), (numero || "").trim());
    return q.getCandidate.get(info.lastInsertRowid);
  },
  updateCandidate: (id, nom, prenom, numero) => {
    q.updateCandidate.run(nom.trim(), prenom.trim(), (numero || "").trim(), id);
    return q.getCandidate.get(id);
  },
  setExcel: (id, filePath, fileName) => {
    q.setExcel.run(filePath, fileName, id);
    return q.getCandidate.get(id);
  },
  deleteCandidate: (id) => q.deleteCandidate.run(id),

  // Évaluations — retourne { itemId: bool }
  getEvaluation: (candidateId, sheet) => {
    const out = {};
    for (const r of q.getEval.all(candidateId, sheet)) out[r.itemId] = !!r.checked;
    return out;
  },
  setEvaluation: (candidateId, sheet, itemId, checked) => {
    q.setEval.run({ candidateId, sheet, itemId, checked: checked ? 1 : 0 });
  },

  // Commentaires
  getComment: (candidateId, sheet) => {
    const r = q.getComment.get(candidateId, sheet);
    return r ? r.text : "";
  },
  setComment: (candidateId, sheet, text) => q.setComment.run(candidateId, sheet, String(text || "")),

  // Utilisateurs
  listUsers: () => q.listUsers.all(),
  getUser: (id) => q.getUser.get(id),
  getUserByName: (username) => q.getUserByName.get(username),
  addUser: (username, passwordHash, displayName, role) => {
    const info = q.addUser.run(username.trim(), passwordHash, (displayName || "").trim(), role);
    return q.getUser.get(info.lastInsertRowid);
  },
  updateUserPassword: (id, passwordHash) => q.updateUserPassword.run(passwordHash, id),
  deleteUser: (id) => q.deleteUser.run(id),
  countAdmins: () => q.countAdmins.get().n,

  // Sessions
  addSession: (token, userId, expiresAt) => q.addSession.run(token, userId, expiresAt),
  getSession: (token) => q.getSession.get(token),
  deleteSession: (token) => q.deleteSession.run(token),
  purgeSessions: () => q.purgeSessions.run(),

  // Commissions
  listCommissions: () => q.listCommissions.all().map(c => ({
    ...c,
    members: q.commissionMembers.all(c.id),
    candidates: q.commissionCandidates.all(c.id),
  })),
  getCommission: (id) => q.getCommission.get(id),
  addCommission: (name) => {
    const info = q.addCommission.run(name.trim());
    return q.getCommission.get(info.lastInsertRowid);
  },
  renameCommission: (id, name) => q.renameCommission.run(name.trim(), id),
  deleteCommission: (id) => q.deleteCommission.run(id),
  addMember: (commissionId, userId) => q.addMember.run(commissionId, userId),
  removeMember: (commissionId, userId) => q.removeMember.run(commissionId, userId),
  addCommCandidate: (commissionId, candidateId) => q.addCommCandidate.run(commissionId, candidateId),
  removeCommCandidate: (commissionId, candidateId) => q.removeCommCandidate.run(commissionId, candidateId),
  userCanSeeCandidate: (userId, candidateId) => !!q.userCanSeeCandidate.get(userId, candidateId),

  // Paramètres
  getSetting: (key) => {
    const r = q.getSetting.get(key);
    return r ? r.value : "";
  },
  setSetting: (key, value) => q.setSetting.run(key, String(value || "")),
};
