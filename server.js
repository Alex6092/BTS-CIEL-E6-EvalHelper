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
const { exportEvaluation, exportFull } = require("./excel");
const { SHEET_CONFIG, SHEET_ORDER, HIERARCHIES, allLeafIds } = require("./hierarchy");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const EXPORT_DIR = path.join(__dirname, "exports");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// IDs valides par onglet (pour la validation WS)
const VALID_IDS = {};
for (const key of SHEET_ORDER) VALID_IDS[key] = allLeafIds(key);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".xlsx";
      cb(null, `candidate_${req.params.id}_${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error("Seuls les fichiers .xlsx sont acceptés."), ok);
  },
});

function publicCandidate(c) {
  return {
    id: c.id, nom: c.nom, prenom: c.prenom, numero: c.numero,
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
  };
}

/* ════════════════ Authentification ════════════════ */

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = store.getUserByName(String(username || "").trim());
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
  for (const key of SHEET_ORDER) {
    if (!allowed.includes(key)) continue;
    sheets[key] = { label: SHEET_CONFIG[key].label, name: SHEET_CONFIG[key].name };
    hierarchies[key] = HIERARCHIES[key];
  }
  res.json({ sheets, hierarchies, order: SHEET_ORDER.filter(k => allowed.includes(k)) });
});

/* ════════════════ Candidats ════════════════ */

app.get("/api/candidates", auth.requireAuth, (req, res) => {
  const list = (req.user.role === "commission")
    ? store.listCandidatesForUser(req.user.id)
    : store.listCandidates();
  res.json(list.map(publicCandidate));
});

app.post("/api/candidates", auth.requireRole("admin", "teacher"), (req, res) => {
  const { nom, prenom, numero } = req.body || {};
  if (!nom || !prenom) return res.status(400).json({ error: "Nom et prénom requis." });
  const c = store.addCandidate(nom, prenom, numero);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(c));
});

app.put("/api/candidates/:id", auth.requireRole("admin", "teacher"), (req, res) => {
  const id = Number(req.params.id);
  if (!store.getCandidate(id)) return res.status(404).json({ error: "Candidat introuvable." });
  const { nom, prenom, numero } = req.body || {};
  if (!nom || !prenom) return res.status(400).json({ error: "Nom et prénom requis." });
  const c = store.updateCandidate(id, nom, prenom, numero);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(c));
});

app.delete("/api/candidates/:id", auth.requireRole("admin", "teacher"), (req, res) => {
  store.deleteCandidate(Number(req.params.id));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/candidates/:id/excel", auth.requireRole("admin", "teacher"),
  upload.single("file"), (req, res) => {
  const id = Number(req.params.id);
  const candidate = store.getCandidate(id);
  if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
  if (candidate.excelPath && fs.existsSync(candidate.excelPath)) {
    try { fs.unlinkSync(candidate.excelPath); } catch {}
  }
  const updated = store.setExcel(id, req.file.path, req.file.originalname);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(updated));
});

/* ════════════════ Évaluations ════════════════ */

app.get("/api/evaluation", auth.requireAuth, (req, res) => {
  const candidateId = Number(req.query.candidateId);
  const sheet = String(req.query.sheet);
  if (!SHEET_CONFIG[sheet]) return res.status(400).json({ error: "Onglet invalide." });
  if (!auth.canAccessSheet(req.user, sheet)) return res.status(403).json({ error: "Accès refusé à cet onglet." });
  if (!auth.canAccessCandidate(req.user, candidateId)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
  res.json({
    state: store.getEvaluation(candidateId, sheet),
    comment: store.getComment(candidateId, sheet),
  });
});

/* ════════════════ Exports ════════════════ */

app.post("/api/export", auth.requireAuth, async (req, res) => {
  try {
    const { candidateId, sheet } = req.body || {};
    if (!SHEET_CONFIG[sheet]) return res.status(400).json({ error: "Onglet invalide." });
    if (!auth.canAccessSheet(req.user, sheet)) return res.status(403).json({ error: "Accès refusé à cet onglet." });
    if (!auth.canAccessCandidate(req.user, candidateId)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
    const candidate = store.getCandidate(Number(candidateId));
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    const { fileName } = await exportEvaluation(candidate, sheet, {
      evaluation: store.getEvaluation(candidate.id, sheet),
      comment: store.getComment(candidate.id, sheet),
      settings: getSettings(),
    });
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/export-full", auth.requireRole("admin", "teacher"), async (req, res) => {
  try {
    const candidate = store.getCandidate(Number((req.body || {}).candidateId));
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    const dataBySheet = {};
    for (const key of SHEET_ORDER) {
      dataBySheet[key] = {
        evaluation: store.getEvaluation(candidate.id, key),
        comment: store.getComment(candidate.id, key),
      };
    }
    const { fileName } = await exportFull(candidate, dataBySheet, getSettings());
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/download/:file", auth.requireAuth, (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(EXPORT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send("Fichier introuvable.");
  res.download(full);
});

/* ════════════════ Administration ════════════════ */

app.get("/api/users", auth.requireRole("admin"), (_req, res) => {
  res.json(store.listUsers());
});

app.post("/api/users", auth.requireRole("admin"), (req, res) => {
  const { username, password, displayName, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  if (!["admin", "teacher", "commission"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  if (store.getUserByName(username.trim())) return res.status(400).json({ error: "Cet identifiant existe déjà." });
  const u = store.addUser(username, auth.hashPassword(password), displayName, role);
  res.json(publicUser(u));
});

app.post("/api/users/:id/password", auth.requireRole("admin"), (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Mot de passe requis." });
  if (!store.getUser(Number(req.params.id))) return res.status(404).json({ error: "Utilisateur introuvable." });
  store.updateUserPassword(Number(req.params.id), auth.hashPassword(password));
  res.json({ ok: true });
});

app.delete("/api/users/:id", auth.requireRole("admin"), (req, res) => {
  const id = Number(req.params.id);
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
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Nom requis." });
  res.json(store.addCommission(name));
});

app.put("/api/commissions/:id", auth.requireRole("admin"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Nom requis." });
  store.renameCommission(Number(req.params.id), name);
  res.json({ ok: true });
});

app.delete("/api/commissions/:id", auth.requireRole("admin"), (req, res) => {
  store.deleteCommission(Number(req.params.id));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/commissions/:id/members", auth.requireRole("admin"), (req, res) => {
  store.addMember(Number(req.params.id), Number((req.body || {}).userId));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/commissions/:id/members/:userId", auth.requireRole("admin"), (req, res) => {
  store.removeMember(Number(req.params.id), Number(req.params.userId));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.post("/api/commissions/:id/candidates", auth.requireRole("admin"), (req, res) => {
  store.addCommCandidate(Number(req.params.id), Number((req.body || {}).candidateId));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});
app.delete("/api/commissions/:id/candidates/:candidateId", auth.requireRole("admin"), (req, res) => {
  store.removeCommCandidate(Number(req.params.id), Number(req.params.candidateId));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

app.get("/api/settings", auth.requireRole("admin"), (_req, res) => {
  res.json(getSettings());
});

app.post("/api/settings", auth.requireRole("admin"), (req, res) => {
  const { academie, etablissement } = req.body || {};
  if (academie !== undefined) store.setSetting("academie", academie);
  if (etablissement !== undefined) store.setSetting("etablissement", etablissement);
  res.json(getSettings());
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
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "subscribe") {
      const sheet = String(msg.sheet);
      const candidateId = Number(msg.candidateId);
      if (!SHEET_CONFIG[sheet]) return;
      if (!auth.canAccessSheet(ws.user, sheet)) return;
      if (!auth.canAccessCandidate(ws.user, candidateId)) return;
      ws.room = roomKey(candidateId, sheet);
      ws.candidateId = candidateId;
      ws.sheet = sheet;
      ws.send(JSON.stringify({
        type: "state",
        state: store.getEvaluation(candidateId, sheet),
        comment: store.getComment(candidateId, sheet),
      }));
    }

    else if (msg.type === "set") {
      if (!ws.room) return;
      const { candidateId, sheet } = ws;
      if (!VALID_IDS[sheet].has(msg.itemId)) return;
      const checked = !!msg.checked;
      store.setEvaluation(candidateId, sheet, msg.itemId, checked);
      broadcastRoom(ws.room, { type: "update", itemId: msg.itemId, checked });
    }

    else if (msg.type === "comment") {
      if (!ws.room) return;
      const text = String(msg.text || "").slice(0, 5000);
      store.setComment(ws.candidateId, ws.sheet, text);
      // Diffuser aux AUTRES clients de la salle (pas l'émetteur, qui tape)
      broadcastRoom(ws.room, { type: "comment", text }, ws);
    }
  });
});

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
