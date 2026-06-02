/* ════════════════════════════════════════════════════════════════
   server.js  —  Backend Express + WebSocket + SQLite + export Excel
   ════════════════════════════════════════════════════════════════ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const store = require("./db");
const { exportEvaluation } = require("./excel");
const { HIERARCHY, SHEETS, allLeafIds } = require("./hierarchy");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const EXPORT_DIR = path.join(__dirname, "exports");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// Servir le module de données partagé au navigateur
app.get("/hierarchy.js", (_req, res) => res.sendFile(path.join(__dirname, "hierarchy.js")));

// ── Upload (fichiers Excel) ──
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

/* ════════════════ API REST ════════════════ */

// Hiérarchie + onglets disponibles
app.get("/api/hierarchy", (_req, res) => {
  res.json({ hierarchy: HIERARCHY, sheets: SHEETS });
});

// Liste des candidats
app.get("/api/candidates", (_req, res) => {
  res.json(store.listCandidates().map(publicCandidate));
});

// Ajout d'un candidat
app.post("/api/candidates", (req, res) => {
  const { nom, prenom, numero } = req.body || {};
  if (!nom || !prenom) return res.status(400).json({ error: "Nom et prénom requis." });
  const c = store.addCandidate(nom, prenom, numero);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(c));
});

// Suppression d'un candidat
app.delete("/api/candidates/:id", (req, res) => {
  store.deleteCandidate(Number(req.params.id));
  broadcastAll({ type: "candidates" });
  res.json({ ok: true });
});

// Association d'un fichier Excel
app.post("/api/candidates/:id/excel", upload.single("file"), (req, res) => {
  const id = Number(req.params.id);
  const candidate = store.getCandidate(id);
  if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });

  // Supprimer l'ancien fichier s'il existe
  if (candidate.excelPath && fs.existsSync(candidate.excelPath)) {
    try { fs.unlinkSync(candidate.excelPath); } catch {}
  }
  const updated = store.setExcel(id, req.file.path, req.file.originalname);
  broadcastAll({ type: "candidates" });
  res.json(publicCandidate(updated));
});

// État d'une évaluation (candidat + onglet)
app.get("/api/evaluation", (req, res) => {
  const candidateId = Number(req.query.candidateId);
  const sheet = String(req.query.sheet);
  if (!SHEETS[sheet]) return res.status(400).json({ error: "Onglet invalide." });
  res.json(store.getEvaluation(candidateId, sheet));
});

// Export Excel (copie)
app.post("/api/export", async (req, res) => {
  try {
    const { candidateId, sheet } = req.body || {};
    if (!SHEETS[sheet]) return res.status(400).json({ error: "Onglet invalide." });
    const candidate = store.getCandidate(Number(candidateId));
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    const evaluation = store.getEvaluation(candidate.id, sheet);
    const { fileName } = await exportEvaluation(candidate, sheet, evaluation);
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Téléchargement d'un export
app.get("/download/:file", (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(EXPORT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send("Fichier introuvable.");
  res.download(full);
});

function publicCandidate(c) {
  return {
    id: c.id, nom: c.nom, prenom: c.prenom, numero: c.numero,
    hasExcel: !!c.excelPath, excelName: c.excelName || null,
  };
}

/* ════════════════ WebSocket (synchro temps réel) ════════════════ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const VALID_IDS = new Set(allLeafIds());

function roomKey(candidateId, sheet) { return candidateId + ":" + sheet; }

wss.on("connection", (ws) => {
  ws.room = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "subscribe") {
      // Rejoindre la salle (candidat + onglet)
      if (!SHEETS[msg.sheet]) return;
      ws.room = roomKey(msg.candidateId, msg.sheet);
      ws.candidateId = Number(msg.candidateId);
      ws.sheet = msg.sheet;
      const state = store.getEvaluation(ws.candidateId, msg.sheet);
      ws.send(JSON.stringify({ type: "state", state }));
    }

    else if (msg.type === "set") {
      // Mise à jour d'un sous-critère
      if (!SHEETS[msg.sheet]) return;
      if (!VALID_IDS.has(msg.itemId)) return;
      const candidateId = Number(msg.candidateId);
      const checked = !!msg.checked;
      store.setEvaluation(candidateId, msg.sheet, msg.itemId, checked);
      // Diffuser à tous les clients de la même salle
      broadcastRoom(roomKey(candidateId, msg.sheet), {
        type: "update", itemId: msg.itemId, checked,
      });
    }
  });
});

function broadcastRoom(room, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.room === room) client.send(data);
  }
}
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

server.listen(PORT, () => {
  console.log(`\n  ✅ Serveur d'évaluation BTS démarré`);
  console.log(`  ➜  Local   : http://localhost:${PORT}`);
  // Afficher les IP réseau pour l'accès multi-clients
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal)
        console.log(`  ➜  Réseau  : http://${net.address}:${PORT}`);
    }
  }
  console.log("");
});
