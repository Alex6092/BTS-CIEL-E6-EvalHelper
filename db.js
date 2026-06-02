/* ════════════════════════════════════════════════════════════════
   db.js  —  Base de données SQLite locale (better-sqlite3)
   ════════════════════════════════════════════════════════════════ */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "evaluations.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nom       TEXT NOT NULL,
    prenom    TEXT NOT NULL,
    numero    TEXT DEFAULT '',
    excelPath TEXT DEFAULT NULL,    -- chemin du fichier Excel associé
    excelName TEXT DEFAULT NULL,    -- nom original du fichier
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    candidateId INTEGER NOT NULL,
    sheet       TEXT NOT NULL,        -- 'R3' ou 'SO'
    itemId      TEXT NOT NULL,        -- id d'un sous-critère (feuille)
    checked     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (candidateId, sheet, itemId),
    FOREIGN KEY (candidateId) REFERENCES candidates(id) ON DELETE CASCADE
  );
`);

// ── Candidats ──
const q = {
  listCandidates: db.prepare("SELECT * FROM candidates ORDER BY nom, prenom"),
  getCandidate:   db.prepare("SELECT * FROM candidates WHERE id = ?"),
  addCandidate:   db.prepare("INSERT INTO candidates (nom, prenom, numero) VALUES (?, ?, ?)"),
  setExcel:       db.prepare("UPDATE candidates SET excelPath = ?, excelName = ? WHERE id = ?"),
  deleteCandidate:db.prepare("DELETE FROM candidates WHERE id = ?"),

  // ── Évaluations ──
  getEval:    db.prepare("SELECT itemId, checked FROM evaluations WHERE candidateId = ? AND sheet = ?"),
  setEval:    db.prepare(`
    INSERT INTO evaluations (candidateId, sheet, itemId, checked)
    VALUES (@candidateId, @sheet, @itemId, @checked)
    ON CONFLICT(candidateId, sheet, itemId)
    DO UPDATE SET checked = @checked
  `),
};

module.exports = {
  db,

  listCandidates: () => q.listCandidates.all(),
  getCandidate:   (id) => q.getCandidate.get(id),
  addCandidate:   (nom, prenom, numero) => {
    const info = q.addCandidate.run(nom.trim(), prenom.trim(), (numero || "").trim());
    return q.getCandidate.get(info.lastInsertRowid);
  },
  setExcel: (id, filePath, fileName) => {
    q.setExcel.run(filePath, fileName, id);
    return q.getCandidate.get(id);
  },
  deleteCandidate: (id) => q.deleteCandidate.run(id),

  // Retourne { itemId: true/false }
  getEvaluation: (candidateId, sheet) => {
    const rows = q.getEval.all(candidateId, sheet);
    const out = {};
    for (const r of rows) out[r.itemId] = !!r.checked;
    return out;
  },
  setEvaluation: (candidateId, sheet, itemId, checked) => {
    q.setEval.run({ candidateId, sheet, itemId, checked: checked ? 1 : 0 });
  },
};
