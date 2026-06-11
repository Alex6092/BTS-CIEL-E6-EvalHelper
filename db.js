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

// Chemin de la base : surchargeable (tests, instances multiples)
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, "evaluations.db");
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS classes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nom       TEXT NOT NULL,
    prenom    TEXT NOT NULL,
    numero    TEXT DEFAULT '',
    classId   INTEGER DEFAULT NULL REFERENCES classes(id) ON DELETE SET NULL,
    excelPath TEXT DEFAULT NULL,
    excelName TEXT DEFAULT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS class_teachers (
    classId INTEGER NOT NULL,
    userId  INTEGER NOT NULL,
    PRIMARY KEY (classId, userId),
    FOREIGN KEY (classId) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
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
    bonus       REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (candidateId, sheet),
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS locks (
    candidateId INTEGER NOT NULL,
    sheet       TEXT NOT NULL,
    lockedAt    TEXT NOT NULL,        -- ISO datetime du verrouillage
    lockedBy    INTEGER,              -- userId (NULL si compte supprimé)
    PRIMARY KEY (candidateId, sheet),
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE,
    FOREIGN KEY (lockedBy) REFERENCES users(id) ON DELETE SET NULL
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

// Migrations sur les bases créées avant l'ajout de ces colonnes
try { db.exec("ALTER TABLE comments ADD COLUMN bonus REAL NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE candidates ADD COLUMN classId INTEGER DEFAULT NULL REFERENCES classes(id) ON DELETE SET NULL"); } catch {}

const CAND_SELECT = `
  SELECT c.*, cl.name AS className
  FROM candidates c LEFT JOIN classes cl ON cl.id = c.classId
`;

const q = {
  // ── Candidats ──
  listCandidates:  db.prepare(CAND_SELECT + " ORDER BY c.nom, c.prenom"),
  // Commission : candidats de ses commissions
  listCandidatesForCommission: db.prepare(`
    SELECT DISTINCT c.*, cl.name AS className FROM candidates c
    LEFT JOIN classes cl ON cl.id = c.classId
    JOIN commission_candidates cc ON cc.candidateId = c.id
    JOIN commission_members cm ON cm.commissionId = cc.commissionId
    WHERE cm.userId = ? ORDER BY c.nom, c.prenom
  `),
  // Enseignant : candidats des classes où il enseigne
  listCandidatesForTeacher: db.prepare(`
    SELECT c.*, cl.name AS className FROM candidates c
    LEFT JOIN classes cl ON cl.id = c.classId
    JOIN class_teachers ct ON ct.classId = c.classId
    WHERE ct.userId = ? ORDER BY c.nom, c.prenom
  `),
  getCandidate:    db.prepare(CAND_SELECT + " WHERE c.id = ?"),
  addCandidate:    db.prepare("INSERT INTO candidates (nom, prenom, numero) VALUES (?, ?, ?)"),
  updateCandidate: db.prepare("UPDATE candidates SET nom = ?, prenom = ?, numero = ? WHERE id = ?"),
  setExcel:        db.prepare("UPDATE candidates SET excelPath = ?, excelName = ? WHERE id = ?"),
  deleteCandidate: db.prepare("DELETE FROM candidates WHERE id = ?"),
  listExcelPaths:  db.prepare("SELECT excelPath FROM candidates WHERE excelPath IS NOT NULL"),
  purgeCandidates: db.prepare("DELETE FROM candidates"),

  // Accès enseignant : le candidat est-il dans une classe où il enseigne ?
  teacherCanSeeCandidate: db.prepare(`
    SELECT 1 FROM candidates c
    JOIN class_teachers ct ON ct.classId = c.classId
    WHERE c.id = ? AND ct.userId = ? LIMIT 1
  `),

  // ── Évaluations ──
  getEval: db.prepare("SELECT itemId, checked FROM evaluations WHERE candidateId = ? AND sheet = ?"),
  setEval: db.prepare(`
    INSERT INTO evaluations (candidateId, sheet, itemId, checked)
    VALUES (@candidateId, @sheet, @itemId, @checked)
    ON CONFLICT(candidateId, sheet, itemId) DO UPDATE SET checked = @checked
  `),

  // ── Verrous ──
  getLock: db.prepare(`
    SELECT l.lockedAt, l.lockedBy, u.displayName AS lockedByName, u.username AS lockedByUser
    FROM locks l LEFT JOIN users u ON u.id = l.lockedBy
    WHERE l.candidateId = ? AND l.sheet = ?
  `),
  isLocked: db.prepare("SELECT 1 FROM locks WHERE candidateId = ? AND sheet = ? LIMIT 1"),
  candidateLocks: db.prepare("SELECT sheet, lockedAt FROM locks WHERE candidateId = ?"),
  insertLock: db.prepare("INSERT OR IGNORE INTO locks (candidateId, sheet, lockedAt, lockedBy) VALUES (?, ?, ?, ?)"),

  // ── Commentaires + bonus ──
  getExtra: db.prepare("SELECT text, bonus FROM comments WHERE candidateId = ? AND sheet = ?"),
  setComment: db.prepare(`
    INSERT INTO comments (candidateId, sheet, text) VALUES (?, ?, ?)
    ON CONFLICT(candidateId, sheet) DO UPDATE SET text = excluded.text
  `),
  setBonus: db.prepare(`
    INSERT INTO comments (candidateId, sheet, bonus) VALUES (?, ?, ?)
    ON CONFLICT(candidateId, sheet) DO UPDATE SET bonus = excluded.bonus
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

  // ── Classes ──
  listClasses:    db.prepare("SELECT * FROM classes ORDER BY name"),
  getClass:       db.prepare("SELECT * FROM classes WHERE id = ?"),
  addClass:       db.prepare("INSERT INTO classes (name) VALUES (?)"),
  renameClass:    db.prepare("UPDATE classes SET name = ? WHERE id = ?"),
  deleteClass:    db.prepare("DELETE FROM classes WHERE id = ?"),
  classTeachers:  db.prepare(`
    SELECT u.id, u.username, u.displayName, u.role FROM class_teachers ct
    JOIN users u ON u.id = ct.userId WHERE ct.classId = ?
  `),
  classCandidates: db.prepare("SELECT id, nom, prenom FROM candidates WHERE classId = ? ORDER BY nom, prenom"),
  detachClassCandidates: db.prepare("UPDATE candidates SET classId = NULL WHERE classId = ?"),
  addClassTeacher:    db.prepare("INSERT OR IGNORE INTO class_teachers (classId, userId) VALUES (?, ?)"),
  removeClassTeacher: db.prepare("DELETE FROM class_teachers WHERE classId = ? AND userId = ?"),
  // Un candidat = une seule classe : on positionne / retire son classId
  setCandidateClass:   db.prepare("UPDATE candidates SET classId = ? WHERE id = ?"),
  clearCandidateClass: db.prepare("UPDATE candidates SET classId = NULL WHERE id = ? AND classId = ?"),

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
  listCandidatesForCommission: (userId) => q.listCandidatesForCommission.all(userId),
  listCandidatesForTeacher: (userId) => q.listCandidatesForTeacher.all(userId),
  teacherCanSeeCandidate: (userId, candidateId) => !!q.teacherCanSeeCandidate.get(candidateId, userId),
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
  listExcelPaths: () => q.listExcelPaths.all().map(r => r.excelPath),

  // Archive (copie atomique de la base) puis suppression de tous les candidats.
  // Conserve comptes, classes, commissions et paramètres.
  archiveDatabase: (destPath) => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    // VACUUM INTO n'accepte pas de paramètre lié : on inline un chemin
    // contrôlé par le serveur (jamais une entrée utilisateur), apostrophes échappées.
    db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
  },
  purgeCandidates: () => q.purgeCandidates.run().changes,

  // Évaluations — retourne { itemId: bool }
  getEvaluation: (candidateId, sheet) => {
    const out = {};
    for (const r of q.getEval.all(candidateId, sheet)) out[r.itemId] = !!r.checked;
    return out;
  },
  setEvaluation: (candidateId, sheet, itemId, checked) => {
    q.setEval.run({ candidateId, sheet, itemId, checked: checked ? 1 : 0 });
  },

  // Verrous
  isLocked: (candidateId, sheet) => !!q.isLocked.get(candidateId, sheet),
  getLock: (candidateId, sheet) => q.getLock.get(candidateId, sheet) || null,
  // Map { sheet: lockedAt } pour un candidat
  getCandidateLocks: (candidateId) => {
    const out = {};
    for (const r of q.candidateLocks.all(candidateId)) out[r.sheet] = r.lockedAt;
    return out;
  },
  // Verrouille si pas déjà verrouillé ; retourne true si le verrou a été posé
  lock: (candidateId, sheet, lockedAt, lockedBy) =>
    q.insertLock.run(candidateId, sheet, lockedAt, lockedBy).changes > 0,

  // Commentaires + bonus — retourne { text, bonus }
  getExtra: (candidateId, sheet) => {
    const r = q.getExtra.get(candidateId, sheet);
    return r ? { text: r.text, bonus: r.bonus } : { text: "", bonus: 0 };
  },
  setComment: (candidateId, sheet, text) => q.setComment.run(candidateId, sheet, String(text || "")),
  setBonus: (candidateId, sheet, bonus) => q.setBonus.run(candidateId, sheet, Number(bonus) || 0),

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
  commissionCanSeeCandidate: (userId, candidateId) => !!q.userCanSeeCandidate.get(userId, candidateId),

  // Classes
  listClasses: () => q.listClasses.all().map(c => ({
    ...c,
    teachers: q.classTeachers.all(c.id),
    candidates: q.classCandidates.all(c.id),
  })),
  getClass: (id) => q.getClass.get(id),
  addClass: (name) => {
    const info = q.addClass.run(name.trim());
    return q.getClass.get(info.lastInsertRowid);
  },
  renameClass: (id, name) => q.renameClass.run(name.trim(), id),
  deleteClass: (id) => {
    q.detachClassCandidates.run(id); // détache les candidats (bases migrées)
    q.deleteClass.run(id);           // CASCADE supprime les class_teachers
  },
  addClassTeacher: (classId, userId) => q.addClassTeacher.run(classId, userId),
  removeClassTeacher: (classId, userId) => q.removeClassTeacher.run(classId, userId),
  setCandidateClass: (candidateId, classId) => q.setCandidateClass.run(classId, candidateId),
  clearCandidateClass: (candidateId, classId) => q.clearCandidateClass.run(candidateId, classId),

  // Paramètres
  getSetting: (key) => {
    const r = q.getSetting.get(key);
    return r ? r.value : "";
  },
  setSetting: (key, value) => q.setSetting.run(key, String(value || "")),
};
