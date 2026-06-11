/* ════════════════════════════════════════════════════════════════
   server.js  —  Backend Express + WebSocket + SQLite + export Excel
   Authentification par rôles : admin / teacher / commission
   ════════════════════════════════════════════════════════════════ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const store = require("./db");
const auth = require("./auth");
const { exportEvaluation, exportFull, exportAll } = require("./excel");
const {
  SHEET_CONFIG, SHEET_ORDER, HIERARCHIES,
  COMP_WEIGHTS, critWeights, allLeafIds,
  computeNote, computeFinalNote,
} = require("./hierarchy");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const EXPORT_DIR = path.join(__dirname, "exports");
const TEMPLATE_PATH = path.join(__dirname, "E6 - Template.xlsx");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// IDs valides par onglet (pour la validation WS)
const VALID_IDS = {};
for (const key of SHEET_ORDER) VALID_IDS[key] = allLeafIds(key);

/* ── Validation des entrées (toutes les données externes passent ici) ──
   Aucune valeur non validée ne doit atteindre la base ou le système de
   fichiers. Les requêtes SQL utilisent exclusivement des requêtes
   préparées avec paramètres liés (better-sqlite3) : pas d'injection SQL
   possible, mais on borne aussi types et tailles pour éviter les abus. */
function intId(v) {
  const n = Number(v);
  return (Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER) ? n : null;
}
function strField(v, max = 200) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return (s.length >= 1 && s.length <= max) ? s : null;
}
function optStrField(v, max = 200) {
  if (v === undefined || v === null || v === "") return "";
  return typeof v === "string" ? v.trim().slice(0, max) : null;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".xlsx";
      cb(null, `candidate_${req.params.id}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error("Seuls les fichiers .xlsx sont acceptés."), ok);
  },
});

/* Propriété des exports : seul l'utilisateur qui a généré un fichier
   peut le télécharger (empêche la récupération d'exports d'autrui en
   devinant un nom de fichier). */
const downloadOwners = new Map(); // fileName -> userId
function registerDownload(fileName, userId) {
  downloadOwners.set(fileName, userId);
  if (downloadOwners.size > 500) {
    const first = downloadOwners.keys().next().value;
    downloadOwners.delete(first);
  }
}

function publicCandidate(c) {
  return {
    id: c.id, nom: c.nom, prenom: c.prenom, numero: c.numero,
    classId: c.classId || null, className: c.className || null,
    hasExcel: !!c.excelPath, excelName: c.excelName || null,
  };
}
function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}
function getSettings() {
  return {
    academie: store.getSetting("academie"),
    etablissement: store.getSetting("etablissement"),
    session: store.getSetting("session"),
  };
}

/* ════════════════ Authentification ════════════════ */

app.post("/api/login", (req, res) => {
  const username = strField((req.body || {}).username, 100);
  const password = (req.body || {}).password;
  if (!username || typeof password !== "string" || password.length > 500) {
    return res.status(401).json({ error: "Identifiants invalides." });
  }
  const user = store.getUserByName(username);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Identifiants invalides." });
  }
  const token = auth.createSession(user.id);
  res.setHeader("Set-Cookie",
    `${auth.COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
  res.json({ user: publicUser(user), allowedSheets: auth.allowedSheets(user) });
});

app.post("/api/logout", auth.requireAuth, (req, res) => {
  store.deleteSession(req.user.token);
  res.setHeader("Set-Cookie", `${auth.COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), allowedSheets: auth.allowedSheets(req.user) });
});

/* ════════════════ Hiérarchie ════════════════ */

app.get("/api/hierarchy", auth.requireAuth, (req, res) => {
  const allowed = auth.allowedSheets(req.user);
  const sheets = {};
  const hierarchies = {};
  const weights = {};
  for (const key of SHEET_ORDER) {
    if (!allowed.includes(key)) continue;
    sheets[key] = { label: SHEET_CONFIG[key].label, name: SHEET_CONFIG[key].name };
    hierarchies[key] = HIERARCHIES[key];
    weights[key] = { comp: COMP_WEIGHTS[key], crit: critWeights(key) };
  }
  res.json({ sheets, hierarchies, weights, order: SHEET_ORDER.filter(k => allowed.includes(k)) });
});

/* ════════════════ Candidats ════════════════ */

function accessibleCandidates(user) {
  if (user.role === "admin") return store.listCandidates();
  if (user.role === "teacher") return store.listCandidatesForTeacher(user.id);
  return store.listCandidatesForCommission(user.id);
}

app.get("/api/candidates", auth.requireAuth, (req, res) => {
  const showNotes = req.user.role !== "commission"; // notes réservées à l'établissement
  res.json(accessibleCandidates(req.user).map(c => {
    const pub = publicCandidate(c);
    if (showNotes) {
      const dataBySheet = fullDataFor(c.id);
      pub.notes = {};
      for (const key of SHEET_ORDER) {
        pub.notes[key] = computeNote(key, dataBySheet[key].evaluation, dataBySheet[key].bonus).noteProposee;
      }
      pub.notes.finale = computeFinalNote(dataBySheet).noteProposee;
    }
    return pub;
  }));
});

// Création / modification / suppression / Excel : ADMINISTRATEUR uniquement
app.post("/api/candidates", auth.requireRole("admin"), (req, res) => {
  const nom = strField((req.body || {}).nom, 100);
  const prenom = strField((req.body || {}).prenom, 100);
  const numero = optStrField((req.body || {}).numero, 50);
  if (!nom || !prenom || numero === null) return res.status(400).json({ error: "Nom et prénom requis." });
  const c = store.addCandidate(nom, prenom, numero);

  // Associer le template Excel par défaut
  if (fs.existsSync(TEMPLATE_PATH)) {
    try {
      const dest = path.join(UPLOAD_DIR, `candidate_${c.id}_${Date.now()}.xlsx`);
      fs.copyFileSync(TEMPLATE_PATH, dest);
      store.setExcel(c.id, dest, "E6 - Template.xlsx");
    } catch {}
  }

  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(store.getCandidate(c.id)));
});

app.put("/api/candidates/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  if (!id || !store.getCandidate(id)) return res.status(404).json({ error: "Candidat introuvable." });
  const nom = strField((req.body || {}).nom, 100);
  const prenom = strField((req.body || {}).prenom, 100);
  const numero = optStrField((req.body || {}).numero, 50);
  if (!nom || !prenom || numero === null) return res.status(400).json({ error: "Nom et prénom requis." });
  const c = store.updateCandidate(id, nom, prenom, numero);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(c));
});

app.delete("/api/candidates/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  const candidate = store.getCandidate(id);
  if (candidate && candidate.excelPath && fs.existsSync(candidate.excelPath)) {
    try { fs.unlinkSync(candidate.excelPath); } catch {}
  }
  store.deleteCandidate(id);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/candidates/:id/excel", auth.requireRole("admin"),
  upload.single("file"), (req, res) => {
  const id = intId(req.params.id);
  const candidate = id ? store.getCandidate(id) : null;
  if (!candidate) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(404).json({ error: "Candidat introuvable." });
  }
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
  if (candidate.excelPath && fs.existsSync(candidate.excelPath)) {
    try { fs.unlinkSync(candidate.excelPath); } catch {}
  }
  const updated = store.setExcel(id, req.file.path, path.basename(req.file.originalname).slice(0, 150));
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(updated));
});

/* ════════════════ Évaluations ════════════════ */

app.get("/api/evaluation", auth.requireAuth, (req, res) => {
  const candidateId = intId(req.query.candidateId);
  const sheet = String(req.query.sheet || "");
  if (!candidateId) return res.status(400).json({ error: "Candidat invalide." });
  if (!SHEET_CONFIG[sheet]) return res.status(400).json({ error: "Onglet invalide." });
  if (!auth.canAccessSheet(req.user, sheet)) return res.status(403).json({ error: "Accès refusé à cet onglet." });
  if (!auth.canAccessCandidate(req.user, candidateId)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
  const extra = store.getExtra(candidateId, sheet);
  res.json({
    state: store.getEvaluation(candidateId, sheet),
    comment: extra.text,
    bonus: extra.bonus,
    canEdit: auth.canEditSheet(req.user, sheet),
  });
});

/* ════════════════ Exports ════════════════ */

app.post("/api/export", auth.requireAuth, async (req, res) => {
  try {
    const candidateId = intId((req.body || {}).candidateId);
    const sheet = String((req.body || {}).sheet || "");
    if (!candidateId) return res.status(400).json({ error: "Candidat invalide." });
    if (!SHEET_CONFIG[sheet]) return res.status(400).json({ error: "Onglet invalide." });
    if (!auth.canAccessSheet(req.user, sheet)) return res.status(403).json({ error: "Accès refusé à cet onglet." });
    if (!auth.canAccessCandidate(req.user, candidateId)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
    const candidate = store.getCandidate(candidateId);
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    const extra = store.getExtra(candidate.id, sheet);
    const { fileName } = await exportEvaluation(candidate, sheet, {
      evaluation: store.getEvaluation(candidate.id, sheet),
      comment: extra.text,
      bonus: extra.bonus,
      settings: getSettings(),
    });
    registerDownload(fileName, req.user.id);
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function fullDataFor(candidateId) {
  const dataBySheet = {};
  for (const key of SHEET_ORDER) {
    const extra = store.getExtra(candidateId, key);
    dataBySheet[key] = {
      evaluation: store.getEvaluation(candidateId, key),
      comment: extra.text,
      bonus: extra.bonus,
    };
  }
  return dataBySheet;
}

app.post("/api/export-full", auth.requireRole("admin", "teacher"), async (req, res) => {
  try {
    const candidateId = intId((req.body || {}).candidateId);
    const candidate = candidateId ? store.getCandidate(candidateId) : null;
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    if (!auth.canAccessCandidate(req.user, candidate.id)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
    const { fileName } = await exportFull(candidate, fullDataFor(candidate.id), getSettings());
    registerDownload(fileName, req.user.id);
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Export groupé : tous les candidats accessibles ayant un Excel associé, dans un zip
// (admin -> tous ; enseignant -> ceux de ses classes)
app.post("/api/export-all", auth.requireRole("admin", "teacher"), async (req, res) => {
  try {
    const accessible = accessibleCandidates(req.user);
    const withExcel = accessible.filter(c => c.excelPath && fs.existsSync(c.excelPath));
    if (!withExcel.length) {
      return res.status(400).json({ error: "Aucun candidat (accessible) n'a de fichier Excel associé." });
    }
    const entries = withExcel.map(candidate => ({ candidate, dataBySheet: fullDataFor(candidate.id) }));
    const { fileName, count } = await exportAll(entries, getSettings());
    registerDownload(fileName, req.user.id);
    res.json({
      downloadUrl: "/download/" + encodeURIComponent(fileName),
      fileName, count, skipped: accessible.length - withExcel.length,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/download/:file", auth.requireAuth, (req, res) => {
  const file = path.basename(req.params.file); // neutralise toute traversée de chemin
  const owner = downloadOwners.get(file);
  if (owner !== req.user.id) return res.status(403).send("Accès refusé.");
  const full = path.join(EXPORT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send("Fichier introuvable.");
  res.download(full);
});

/* ════════════════ Administration ════════════════ */

app.get("/api/users", auth.requireRole("admin"), (_req, res) => {
  res.json(store.listUsers());
});

app.post("/api/users", auth.requireRole("admin"), (req, res) => {
  const username = strField((req.body || {}).username, 100);
  const password = (req.body || {}).password;
  const displayName = optStrField((req.body || {}).displayName, 100);
  const role = (req.body || {}).role;
  if (!username || typeof password !== "string" || password.length < 1 || password.length > 500 || displayName === null) {
    return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  }
  if (!["admin", "teacher", "commission"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  if (store.getUserByName(username)) return res.status(400).json({ error: "Cet identifiant existe déjà." });
  const u = store.addUser(username, auth.hashPassword(password), displayName, role);
  res.json(publicUser(u));
});

app.post("/api/users/:id/password", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  const password = (req.body || {}).password;
  if (typeof password !== "string" || password.length < 1 || password.length > 500) {
    return res.status(400).json({ error: "Mot de passe requis." });
  }
  if (!id || !store.getUser(id)) return res.status(404).json({ error: "Utilisateur introuvable." });
  store.updateUserPassword(id, auth.hashPassword(password));
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  const target = store.getUser(id);
  if (!target) return res.status(404).json({ error: "Utilisateur introuvable." });
  if (target.role === "admin" && store.countAdmins() <= 1) {
    return res.status(400).json({ error: "Impossible de supprimer le dernier administrateur." });
  }
  if (id === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre compte." });
  store.deleteUser(id);
  res.json({ ok: true });
});

app.get("/api/commissions", auth.requireRole("admin"), (_req, res) => {
  res.json(store.listCommissions());
});

app.post("/api/commissions", auth.requireRole("admin"), (req, res) => {
  const name = strField((req.body || {}).name, 150);
  if (!name) return res.status(400).json({ error: "Nom requis." });
  res.json(store.addCommission(name));
});

app.put("/api/commissions/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  const name = strField((req.body || {}).name, 150);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  if (!name) return res.status(400).json({ error: "Nom requis." });
  store.renameCommission(id, name);
  res.json({ ok: true });
});

app.delete("/api/commissions/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  store.deleteCommission(id);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/commissions/:id/members", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), userId = intId((req.body || {}).userId);
  if (!id || !userId) return res.status(400).json({ error: "Identifiant invalide." });
  if (!store.getCommission(id) || !store.getUser(userId)) return res.status(404).json({ error: "Introuvable." });
  store.addMember(id, userId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/commissions/:id/members/:userId", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), userId = intId(req.params.userId);
  if (!id || !userId) return res.status(400).json({ error: "Identifiant invalide." });
  store.removeMember(id, userId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/commissions/:id/candidates", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), candidateId = intId((req.body || {}).candidateId);
  if (!id || !candidateId) return res.status(400).json({ error: "Identifiant invalide." });
  if (!store.getCommission(id) || !store.getCandidate(candidateId)) return res.status(404).json({ error: "Introuvable." });
  store.addCommCandidate(id, candidateId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/commissions/:id/candidates/:candidateId", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), candidateId = intId(req.params.candidateId);
  if (!id || !candidateId) return res.status(400).json({ error: "Identifiant invalide." });
  store.removeCommCandidate(id, candidateId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

/* ════════════════ Classes (admin) ════════════════ */

app.get("/api/classes", auth.requireRole("admin"), (_req, res) => {
  res.json(store.listClasses());
});

app.post("/api/classes", auth.requireRole("admin"), (req, res) => {
  const name = strField((req.body || {}).name, 150);
  if (!name) return res.status(400).json({ error: "Nom requis." });
  res.json(store.addClass(name));
});

app.put("/api/classes/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), name = strField((req.body || {}).name, 150);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  if (!name) return res.status(400).json({ error: "Nom requis." });
  store.renameClass(id, name);
  res.json({ ok: true });
});

app.delete("/api/classes/:id", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: "Identifiant invalide." });
  store.deleteClass(id);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/classes/:id/teachers", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), userId = intId((req.body || {}).userId);
  if (!id || !userId) return res.status(400).json({ error: "Identifiant invalide." });
  const u = store.getUser(userId);
  if (!store.getClass(id) || !u) return res.status(404).json({ error: "Introuvable." });
  if (u.role !== "teacher") return res.status(400).json({ error: "Seul un enseignant peut être rattaché à une classe." });
  store.addClassTeacher(id, userId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/classes/:id/teachers/:userId", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), userId = intId(req.params.userId);
  if (!id || !userId) return res.status(400).json({ error: "Identifiant invalide." });
  store.removeClassTeacher(id, userId);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/classes/:id/candidates", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), candidateId = intId((req.body || {}).candidateId);
  if (!id || !candidateId) return res.status(400).json({ error: "Identifiant invalide." });
  if (!store.getClass(id) || !store.getCandidate(candidateId)) return res.status(404).json({ error: "Introuvable." });
  store.setCandidateClass(candidateId, id); // un candidat = une seule classe
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/classes/:id/candidates/:candidateId", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id), candidateId = intId(req.params.candidateId);
  if (!id || !candidateId) return res.status(400).json({ error: "Identifiant invalide." });
  store.clearCandidateClass(candidateId, id);
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

/* ════════════════ Purge annuelle (admin) ════════════════
   Archive la base puis supprime tous les candidats et leurs fichiers. */
app.post("/api/purge", auth.requireRole("admin"), (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const archivePath = path.join(DATA_DIR, `archive-${stamp}.db`);
    store.archiveDatabase(archivePath);

    // Supprimer les fichiers Excel des candidats avant de purger la base
    let filesRemoved = 0;
    for (const p of store.listExcelPaths()) {
      try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); filesRemoved++; } } catch {}
    }
    const removed = store.purgeCandidates();
    broadcastAll({ type: "candidates" });
    res.json({ ok: true, archived: path.basename(archivePath), removed, filesRemoved });
  } catch (e) {
    res.status(500).json({ error: "Échec de la purge : " + e.message });
  }
});

app.get("/api/settings", auth.requireRole("admin"), (_req, res) => {
  res.json(getSettings());
});

app.post("/api/settings", auth.requireRole("admin"), (req, res) => {
  const body = req.body || {};
  for (const key of ["academie", "etablissement", "session"]) {
    if (body[key] !== undefined) {
      const v = optStrField(body[key], 100);
      if (v === null) return res.status(400).json({ error: "Valeur invalide pour " + key + "." });
      store.setSetting(key, v);
    }
  }
  res.json(getSettings());
});

/* ════════════════ Gestion d'erreurs globale ════════════════
   JSON malformé, fichier trop volumineux, mauvais type… : réponse 4xx
   propre, jamais de stack trace exposée, le serveur ne tombe pas. */
app.use((err, _req, res, _next) => {
  const status = (err && (err.status || err.statusCode)) ||
    (err && err.code === "LIMIT_FILE_SIZE" ? 413 : 400);
  const msg = err && err.code === "LIMIT_FILE_SIZE"
    ? "Fichier trop volumineux (25 Mo max)."
    : (err && err.type === "entity.parse.failed" ? "Corps de requête invalide."
      : (err && err.message) || "Requête invalide.");
  res.status(status >= 400 && status < 600 ? status : 400).json({ error: msg });
});

/* ════════════════ WebSocket (synchro temps réel) ════════════════ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function roomKey(candidateId, sheet) { return candidateId + ":" + sheet; }

wss.on("connection", (ws, req) => {
  const user = auth.userFromRequest(req);
  if (!user) { ws.close(4001, "Authentification requise"); return; }
  ws.user = user;
  ws.room = null;

  ws.on("message", (raw) => {
    // Aucune donnée WS n'est digne de confiance : tout est validé, et
    // toute erreur est contenue (un payload malveillant ne doit jamais
    // faire tomber le serveur).
    try { handleWsMessage(ws, raw); } catch {}
  });
});

function handleWsMessage(ws, raw) {
    if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return;
    if (raw.length > 20000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "subscribe") {
      const sheet = String(msg.sheet);
      const candidateId = intId(msg.candidateId);
      if (!candidateId) return;
      if (!SHEET_CONFIG[sheet]) return;
      if (!auth.canAccessSheet(ws.user, sheet)) return;
      if (!auth.canAccessCandidate(ws.user, candidateId)) return;
      ws.room = roomKey(candidateId, sheet);
      ws.candidateId = candidateId;
      ws.sheet = sheet;
      const extra = store.getExtra(candidateId, sheet);
      ws.send(JSON.stringify({
        type: "state",
        state: store.getEvaluation(candidateId, sheet),
        comment: extra.text,
        bonus: extra.bonus,
        canEdit: auth.canEditSheet(ws.user, sheet),
      }));
    }

    else if (msg.type === "set") {
      if (!ws.room) return;
      if (!auth.canEditSheet(ws.user, ws.sheet)) return; // SO : commissions uniquement
      const { candidateId, sheet } = ws;
      if (typeof msg.itemId !== "string" || !VALID_IDS[sheet].has(msg.itemId)) return;
      const checked = !!msg.checked;
      store.setEvaluation(candidateId, sheet, msg.itemId, checked);
      broadcastRoom(ws.room, { type: "update", itemId: msg.itemId, checked });
    }

    else if (msg.type === "comment") {
      if (!ws.room) return;
      if (!auth.canEditSheet(ws.user, ws.sheet)) return;
      if (typeof msg.text !== "string") return;
      const text = msg.text.slice(0, 5000);
      store.setComment(ws.candidateId, ws.sheet, text);
      // Diffuser aux AUTRES clients de la salle (pas l'émetteur, qui tape)
      broadcastRoom(ws.room, { type: "comment", text }, ws);
    }

    else if (msg.type === "bonus") {
      if (!ws.room) return;
      if (!auth.canEditSheet(ws.user, ws.sheet)) return;
      // Bonus sur 2 points, borné [0, 2] ; NaN/Infinity/objets rejetés
      const n = Number(msg.bonus);
      if (!Number.isFinite(n)) return;
      const bonus = Math.max(0, Math.min(2, n));
      store.setBonus(ws.candidateId, ws.sheet, bonus);
      broadcastRoom(ws.room, { type: "bonus", bonus }, ws);
    }
}

function broadcastRoom(room, payload, except) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.room === room && client !== except) client.send(data);
  }
}
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/* ════════════════ Démarrage ════════════════ */
store.purgeSessions();
const created = auth.ensureDefaultAdmin();

server.listen(PORT, () => {
  console.log(`\n  ✅ Serveur d'évaluation E6 démarré`);
  console.log(`  ➜  Local   : http://localhost:${PORT}`);
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal)
        console.log(`  ➜  Réseau  : http://${net.address}:${PORT}`);
    }
  }
  if (created) {
    console.log(`\n  ⚠ Compte administrateur créé : ${created.username} / ${created.password}`);
    console.log(`    Changez ce mot de passe depuis le panneau d'administration.`);
  }
  console.log("");
});
