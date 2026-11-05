/* ════════════════════════════════════════════════════════════════
   server.js  —  Backend Express + WebSocket + SQLite + export Excel
   Authentification par rôles : admin / teacher / commission
   ════════════════════════════════════════════════════════════════ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const store = require("./db");
const auth = require("./auth");
const { createLimiter, tooManyAttempts } = require("./ratelimit");
const { exportEvaluation, exportFull, exportAll } = require("./excel");
const {
  SHEET_CONFIG, SHEET_ORDER, HIERARCHIES,
  COMP_WEIGHTS, critWeights, allLeafIds,
  proposedNote, computeFinalNote, isValidOverride,
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

/* ── Limitation des tentatives ──
   - connexion : échecs comptés par (IP + identifiant) et par IP
   - inscription : toutes les tentatives, par IP (marge pour un groupe de
     jurés qui s'inscrit au même moment depuis le même réseau)
   - vérification du mot de passe d'un compte connecté (changement de mot
     de passe, verrouillage du lot) : échecs par utilisateur */
const MIN15 = 15 * 60 * 1000;
const loginUserLimiter = createLimiter({ windowMs: MIN15, max: 10 });
const loginIpLimiter = createLimiter({ windowMs: MIN15, max: 50 });
const registerLimiter = createLimiter({ windowMs: MIN15, max: 30 });
const passwordCheckLimiter = createLimiter({ windowMs: MIN15, max: 10 });

const app = express();
app.disable("x-powered-by");
// Derrière nginx (même machine), req.ip = adresse réelle du client, lue dans
// X-Forwarded-For. L'en-tête n'est pris en compte que si la connexion vient
// de la machine elle-même : un client distant ne peut pas falsifier son IP.
app.set("trust proxy", "loopback");

/* ── Requêtes venant d'un autre site (CSRF, WebSocket détourné) ──
   Le cookie SameSite=Lax ne protège pas contre une page hébergée sur le
   même « site » (autre port de la même machine, sous-domaine voisin).
   On refuse donc toute requête d'écriture et toute connexion WebSocket qui
   ne provient pas de l'application elle-même :
   - navigateurs récents : en-tête Sec-Fetch-Site (seuls « same-origin » et
     « none », saisie directe, sont acceptés) ;
   - sinon : l'en-tête Origin doit correspondre à l'hôte demandé (ou à
     PUBLIC_ORIGIN si défini, ex. derrière un proxy qui modifie Host).
   Sans aucun de ces en-têtes (client non navigateur), il n'y a pas
   d'attaque inter-sites possible : la requête est acceptée. */
const PUBLIC_ORIGINS = String(process.env.PUBLIC_ORIGIN || "")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);

function fromOtherSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.origin;
  if (!origin) return false;
  if (PUBLIC_ORIGINS.length) return !PUBLIC_ORIGINS.includes(origin);
  try { return new URL(origin).host !== String(req.headers.host || ""); }
  catch { return true; } // Origin « null » ou invalide
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.use((req, res, next) => {
  if (UNSAFE_METHODS.has(req.method) && fromOtherSite(req)) {
    return res.status(403).json({ error: "Requête refusée : origine non autorisée." });
  }
  next();
});

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    // Nom entièrement choisi par le serveur : ni l'URL (:id, décodée par
    // Express, peut contenir « ../ ») ni le nom d'origine n'entrent dans le chemin
    filename: (req, _file, cb) => {
      const id = intId(req.params.id) || 0;
      cb(null, `candidate_${id}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.xlsx`);
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

/* ── Visibilité & édition d'un onglet pour un candidat ──
   Règle soutenance : tant que la commission n'a pas verrouillé l'onglet SO,
   l'établissement (enseignant/admin) ne peut NI le voir NI l'exporter. */
function canViewSheet(user, candidateId, sheet) {
  if (!auth.canAccessSheet(user, sheet)) return false;
  if (!auth.canAccessCandidate(user, candidateId)) return false;
  if (sheet === "SO" && user.role !== "commission") {
    return store.isLocked(candidateId, "SO"); // visible seulement une fois verrouillée
  }
  return true;
}

/* Peut-on encore ÉDITER (saisie/commentaire/bonus) cet onglet ?
   Non si verrouillé (personne, pas même l'admin). */
function canEditSheetNow(user, candidateId, sheet) {
  if (!auth.canEditSheet(user, sheet)) return false;
  if (!auth.canAccessCandidate(user, candidateId)) return false;
  if (store.isLocked(candidateId, sheet)) return false;
  return true;
}

/* Qui a le DROIT de verrouiller un onglet (avant verrouillage) :
   les mêmes que ceux qui peuvent l'éditer (SO -> commission, autres -> établissement). */
function canLockSheet(user, candidateId, sheet) {
  return auth.canEditSheet(user, sheet) && auth.canAccessCandidate(user, candidateId);
}

// Date (jj/mm/aaaa) à reporter dans l'Excel : date de verrouillage si verrouillé
function lockDateFr(candidateId, sheet) {
  const lk = store.getLock(candidateId, sheet);
  if (!lk) return null;
  return new Date(lk.lockedAt).toLocaleDateString("fr-FR");
}

/* ════════════════ Authentification ════════════════ */

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${auth.COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
}

app.post("/api/login", (req, res) => {
  const username = strField((req.body || {}).username, 100);
  const password = (req.body || {}).password;
  if (!username || typeof password !== "string" || password.length > 500) {
    return res.status(401).json({ error: "Identifiants invalides." });
  }
  const ipKey = req.ip;
  const userKey = req.ip + "|" + username.toLowerCase();
  const wait = Math.max(loginIpLimiter.blockedFor(ipKey), loginUserLimiter.blockedFor(userKey));
  if (wait) return tooManyAttempts(res, wait);

  const user = store.getUserByName(username);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    loginIpLimiter.hit(ipKey);
    loginUserLimiter.hit(userKey);
    return res.status(401).json({ error: "Identifiants invalides." });
  }
  loginUserLimiter.reset(userKey);
  setSessionCookie(res, auth.createSession(user.id));
  res.json({ user: publicUser(user), allowedSheets: auth.allowedSheets(user) });
});

/* ── Inscription publique des membres de commission ──
   Ouverte / fermée par l'administrateur. Le compte créé a TOUJOURS le rôle
   « commission » (tout rôle envoyé par le client est ignoré) et ne voit aucun
   candidat tant que l'admin ne l'a pas associé à une commission. */
function registrationOpen() {
  return store.getSetting("registrationOpen") === "1";
}

// Public : l'écran de connexion affiche le lien « Créer un compte » si ouvert
app.get("/api/registration", (_req, res) => {
  res.json({ open: registrationOpen() });
});

// Admin : ouvrir / fermer les inscriptions
app.post("/api/registration", auth.requireRole("admin"), (req, res) => {
  const open = (req.body || {}).open;
  if (typeof open !== "boolean") return res.status(400).json({ error: "Valeur invalide." });
  store.setSetting("registrationOpen", open ? "1" : "0");
  res.json({ open });
});

app.post("/api/register", (req, res) => {
  const wait = registerLimiter.blockedFor(req.ip);
  if (wait) return tooManyAttempts(res, wait);
  registerLimiter.hit(req.ip);

  // Revérifié à chaque envoi : le formulaire a pu rester ouvert à l'écran
  if (!registrationOpen()) {
    return res.status(403).json({ error: "Les inscriptions sont fermées. Contactez l'administrateur." });
  }
  const body = req.body || {};
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!auth.USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Identifiant invalide : " + auth.USERNAME_RULE });
  }
  const displayName = strField(body.displayName, 100);
  if (!displayName) return res.status(400).json({ error: "Nom et prénom requis." });
  const pwError = auth.checkNewPassword(body.password);
  if (pwError) return res.status(400).json({ error: pwError });
  if (store.getUserByNameNoCase(username)) {
    return res.status(400).json({ error: "Cet identifiant est déjà utilisé." });
  }

  let user;
  try {
    user = store.addUser(username, auth.hashPassword(body.password), displayName, "commission", true);
  } catch {
    // Deux inscriptions simultanées avec le même identifiant (contrainte UNIQUE)
    return res.status(400).json({ error: "Cet identifiant est déjà utilisé." });
  }
  setSessionCookie(res, auth.createSession(user.id));
  res.json({ user: publicUser(user), allowedSheets: auth.allowedSheets(user) });
});

// Changement de son propre mot de passe (tous les rôles)
app.post("/api/me/password", auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 500) {
    return res.status(400).json({ error: "Mot de passe actuel requis." });
  }
  const key = "user:" + req.user.id;
  const wait = passwordCheckLimiter.blockedFor(key);
  if (wait) return tooManyAttempts(res, wait);

  const fullUser = store.getUser(req.user.id);
  // 403 et non 401 : le client interprète 401 comme « session expirée »
  if (!fullUser || !auth.verifyPassword(currentPassword, fullUser.passwordHash)) {
    passwordCheckLimiter.hit(key);
    return res.status(403).json({ error: "Mot de passe actuel incorrect." });
  }
  passwordCheckLimiter.reset(key);
  const pwError = auth.checkNewPassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'actuel." });
  }
  store.updateUserPassword(req.user.id, auth.hashPassword(newPassword));
  // Déconnecte les autres navigateurs / appareils, garde la session courante
  store.deleteUserSessions(req.user.id, req.user.token);
  closeUserSockets(req.user.id, req.user.token);
  res.json({ ok: true });
});

app.post("/api/logout", auth.requireAuth, (req, res) => {
  store.deleteSession(req.user.token);
  closeSessionSockets(req.user.token); // les WebSocket de cette session aussi
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
  const isCommission = req.user.role === "commission";
  res.json(accessibleCandidates(req.user).map(c => {
    const pub = publicCandidate(c);
    const locks = store.getCandidateLocks(c.id);          // { sheet: lockedAt }
    const soLocked = !!locks.SO;

    if (isCommission) {
      // La commission ne voit pas les notes, mais le cadenas du candidat (SO verrouillée)
      pub.soLocked = soLocked;
      return pub;
    }

    // Établissement : notes + état de verrouillage + note définitive par onglet
    const dataBySheet = fullDataFor(c.id);
    pub.notes = {};
    pub.locks = {};
    pub.overrides = {};
    for (const key of SHEET_ORDER) {
      pub.locks[key] = !!locks[key];
      const d = dataBySheet[key];
      // La soutenance n'est visible qu'une fois verrouillée par la commission :
      // ni sa note, ni même le fait qu'une note définitive ait été saisie
      const visible = key !== "SO" || soLocked;
      pub.overrides[key] = visible && isValidOverride(d.noteOverride);
      pub.notes[key] = visible ? proposedNote(key, d.evaluation, d.bonus, d.noteOverride) : null;
    }
    // Note finale : seulement si la soutenance est communiquée (verrouillée)
    pub.notes.finale = soLocked ? computeFinalNote(dataBySheet).noteProposee : null;
    pub.finaleLocked = soLocked;
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
  const lock = store.getLock(candidateId, sheet);
  // Soutenance non communiquée à l'établissement : pas de données renvoyées
  if (!canViewSheet(req.user, candidateId, sheet)) {
    return res.json({ hidden: true, locked: !!lock });
  }
  const extra = store.getExtra(candidateId, sheet);
  res.json({
    state: store.getEvaluation(candidateId, sheet),
    comment: extra.text,
    bonus: extra.bonus,
    noteOverride: extra.noteOverride,
    locked: !!lock,
    lockedAt: lock ? lock.lockedAt : null,
    lockedByName: lock ? (lock.lockedByName || lock.lockedByUser || "—") : null,
    canEdit: canEditSheetNow(req.user, candidateId, sheet),
    canLock: !lock && canLockSheet(req.user, candidateId, sheet),
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
    // Soutenance non communiquée : l'établissement ne peut pas l'exporter
    if (!canViewSheet(req.user, candidateId, sheet)) {
      return res.status(403).json({ error: "L'onglet Soutenance n'est pas encore communiqué (verrouillé par la commission)." });
    }
    const candidate = store.getCandidate(candidateId);
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    const extra = store.getExtra(candidate.id, sheet);
    const { fileName } = await exportEvaluation(candidate, sheet, {
      evaluation: store.getEvaluation(candidate.id, sheet),
      comment: extra.text,
      bonus: extra.bonus,
      noteOverride: extra.noteOverride,
      dateOverride: lockDateFr(candidate.id, sheet),
      settings: getSettings(),
    });
    registerDownload(fileName, req.user.id);
    res.json({ downloadUrl: "/download/" + encodeURIComponent(fileName), fileName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Données complètes d'un candidat (toutes feuilles), avec date de verrouillage
function fullDataFor(candidateId) {
  const dataBySheet = {};
  for (const key of SHEET_ORDER) {
    const extra = store.getExtra(candidateId, key);
    dataBySheet[key] = {
      evaluation: store.getEvaluation(candidateId, key),
      comment: extra.text,
      bonus: extra.bonus,
      noteOverride: extra.noteOverride,
      dateOverride: lockDateFr(candidateId, key),
    };
  }
  return dataBySheet;
}

// Idem mais masque les onglets non visibles par l'utilisateur (soutenance
// non verrouillée -> null -> laissé vierge dans l'export)
function exportDataFor(candidateId, user) {
  const d = fullDataFor(candidateId);
  for (const key of SHEET_ORDER) {
    if (!canViewSheet(user, candidateId, key)) d[key] = null;
  }
  return d;
}

app.post("/api/export-full", auth.requireRole("admin", "teacher"), async (req, res) => {
  try {
    const candidateId = intId((req.body || {}).candidateId);
    const candidate = candidateId ? store.getCandidate(candidateId) : null;
    if (!candidate) return res.status(404).json({ error: "Candidat introuvable." });
    if (!auth.canAccessCandidate(req.user, candidate.id)) return res.status(403).json({ error: "Accès refusé à ce candidat." });
    const { fileName } = await exportFull(candidate, exportDataFor(candidate.id, req.user), getSettings());
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
    const entries = withExcel.map(candidate => ({ candidate, dataBySheet: exportDataFor(candidate.id, req.user) }));
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

/* ════════════════ Verrouillage ════════════════ */

// Verrouille un onglet pour un candidat (action irréversible).
app.post("/api/lock", auth.requireAuth, (req, res) => {
  const candidateId = intId((req.body || {}).candidateId);
  const sheet = String((req.body || {}).sheet || "");
  if (!candidateId) return res.status(400).json({ error: "Candidat invalide." });
  if (!SHEET_CONFIG[sheet]) return res.status(400).json({ error: "Onglet invalide." });
  if (!store.getCandidate(candidateId)) return res.status(404).json({ error: "Candidat introuvable." });
  if (!canLockSheet(req.user, candidateId, sheet)) {
    return res.status(403).json({ error: "Vous n'avez pas le droit de verrouiller cet onglet." });
  }
  if (store.isLocked(candidateId, sheet)) {
    return res.status(400).json({ error: "Cet onglet est déjà verrouillé." });
  }
  const lockedAt = new Date().toISOString();
  store.lock(candidateId, sheet, lockedAt, req.user.id);
  broadcastLockChanged(candidateId, sheet);
  res.json({ ok: true, lockedAt });
});

// Verrouille le LOT : toutes les soutenances des candidats attribués au membre
// de commission. Double confirmation côté client + mot de passe ici.
app.post("/api/lock-batch", auth.requireRole("commission"), (req, res) => {
  const password = (req.body || {}).password;
  if (typeof password !== "string" || password.length < 1 || password.length > 500) {
    return res.status(400).json({ error: "Mot de passe requis." });
  }
  const key = "user:" + req.user.id;
  const wait = passwordCheckLimiter.blockedFor(key);
  if (wait) return tooManyAttempts(res, wait);
  const fullUser = store.getUser(req.user.id);
  // 403 et non 401 : le client interprète 401 comme « session expirée »
  // et renverrait le juré à l'écran de connexion
  if (!fullUser || !auth.verifyPassword(password, fullUser.passwordHash)) {
    passwordCheckLimiter.hit(key);
    return res.status(403).json({ error: "Mot de passe incorrect." });
  }
  passwordCheckLimiter.reset(key);
  const candidates = store.listCandidatesForCommission(req.user.id);
  const lockedAt = new Date().toISOString();
  let locked = 0;
  for (const c of candidates) {
    if (store.lock(c.id, "SO", lockedAt, req.user.id)) {
      locked++;
      broadcastLockChanged(c.id, "SO");
    }
  }
  res.json({ ok: true, locked, total: candidates.length });
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
  if (!username || typeof password !== "string" || displayName === null) {
    return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  }
  const pwError = auth.checkNewPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  if (!["admin", "teacher", "commission"].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
  if (store.getUserByNameNoCase(username)) return res.status(400).json({ error: "Cet identifiant existe déjà." });
  const u = store.addUser(username, auth.hashPassword(password), displayName, role);
  res.json(publicUser(u));
});

// Réinitialisation par l'admin (mot de passe oublié) : mot de passe provisoire,
// toutes les sessions du compte sont fermées
app.post("/api/users/:id/password", auth.requireRole("admin"), (req, res) => {
  const id = intId(req.params.id);
  const password = (req.body || {}).password;
  const pwError = auth.checkNewPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  if (!id || !store.getUser(id)) return res.status(404).json({ error: "Utilisateur introuvable." });
  store.updateUserPassword(id, auth.hashPassword(password));
  // L'admin qui réinitialise son propre compte garde sa session courante
  const keep = id === req.user.id ? req.user.token : undefined;
  store.deleteUserSessions(id, keep);
  closeUserSockets(id, keep);
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
  store.deleteUser(id); // CASCADE : sessions, appartenances aux commissions/classes
  closeUserSockets(id);
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
   Archive la base puis supprime tous les candidats et leurs fichiers.
   Action destructrice : le mot de passe de l'admin est exigé (une requête
   forgée par une autre page ne peut pas le fournir). */
app.post("/api/purge", auth.requireRole("admin"), (req, res) => {
  const password = (req.body || {}).password;
  if (typeof password !== "string" || password.length < 1 || password.length > 500) {
    return res.status(400).json({ error: "Mot de passe requis." });
  }
  const key = "user:" + req.user.id;
  const wait = passwordCheckLimiter.blockedFor(key);
  if (wait) return tooManyAttempts(res, wait);
  const fullUser = store.getUser(req.user.id);
  if (!fullUser || !auth.verifyPassword(password, fullUser.passwordHash)) {
    passwordCheckLimiter.hit(key);
    return res.status(403).json({ error: "Mot de passe incorrect." });
  }
  passwordCheckLimiter.reset(key);
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

/* Limites WebSocket :
   - message de 64 Ko maximum (au lieu de 100 Mo par défaut) : un commentaire
     fait au plus 5000 caractères ;
   - 20 connexions simultanées par utilisateur (plusieurs onglets) ;
   - 300 messages par tranche de 10 s et par connexion (cocher un critère
     parent envoie un message par sous-critère). */
const WS_MAX_PAYLOAD = 64 * 1024;
const WS_MAX_SOCKETS_PER_USER = 20;
const WS_MAX_MESSAGES = 300;
const WS_MESSAGE_WINDOW_MS = 10 * 1000;

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

/* Ouverture d'une connexion WebSocket : origine contrôlée AVANT la poignée
   de main. Toute erreur est contenue : une requête malformée ne doit jamais
   faire tomber le serveur. */
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  try {
    if (fromOtherSite(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    socket.destroy();
  }
});

function roomKey(candidateId, sheet) { return candidateId + ":" + sheet; }

wss.on("connection", (ws, req) => {
  // Trame invalide, message trop gros… : `ws` émet « error » puis ferme la
  // connexion. Sans écouteur, cet événement arrêtait tout le processus.
  ws.on("error", () => {});
  let user = null;
  try { user = auth.userFromRequest(req); } catch {}
  if (!user) { ws.close(4001, "Authentification requise"); return; }
  let count = 0;
  for (const c of wss.clients) if (c.user && c.user.id === user.id) count++;
  if (count >= WS_MAX_SOCKETS_PER_USER) { ws.close(1008, "Trop de connexions"); return; }
  ws.user = user;
  ws.room = null;
  ws.msgWindowStart = Date.now();
  ws.msgCount = 0;

  ws.on("message", (raw) => {
    // Aucune donnée WS n'est digne de confiance : tout est validé, et
    // toute erreur est contenue (un payload malveillant ne doit jamais
    // faire tomber le serveur).
    try { handleWsMessage(ws, raw); } catch {}
  });
});

/* La session est-elle toujours valide (non déconnectée, non expirée, compte
   existant) ? Revérifié à chaque message : une connexion ouverte ne garde
   pas ses droits au-delà de sa session. */
function wsSessionValid(ws) {
  if (store.getSession(ws.user.token)) return true;
  try { ws.close(4001, "Session expirée"); } catch {}
  return false;
}

function handleWsMessage(ws, raw) {
    if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return;
    const now = Date.now();
    if (now - ws.msgWindowStart > WS_MESSAGE_WINDOW_MS) { ws.msgWindowStart = now; ws.msgCount = 0; }
    if (++ws.msgCount > WS_MAX_MESSAGES) { ws.close(1008, "Trop de messages"); return; }
    if (raw.length > 20000) return;
    if (!wsSessionValid(ws)) return;
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
      ws.candidateId = candidateId;
      ws.sheet = sheet;
      const lock = store.getLock(candidateId, sheet);
      // Soutenance non communiquée à l'établissement : on ne rejoint PAS la
      // salle (sinon il recevrait les modifications en direct de la commission)
      if (!canViewSheet(ws.user, candidateId, sheet)) {
        ws.room = null;
        ws.send(JSON.stringify({ type: "state", hidden: true, locked: !!lock }));
        return;
      }
      ws.room = roomKey(candidateId, sheet);
      const extra = store.getExtra(candidateId, sheet);
      ws.send(JSON.stringify({
        type: "state",
        state: store.getEvaluation(candidateId, sheet),
        comment: extra.text,
        bonus: extra.bonus,
        noteOverride: extra.noteOverride,
        locked: !!lock,
        lockedAt: lock ? lock.lockedAt : null,
        lockedByName: lock ? (lock.lockedByName || lock.lockedByUser || "—") : null,
        canEdit: canEditSheetNow(ws.user, candidateId, sheet),
        canLock: !lock && canLockSheet(ws.user, candidateId, sheet),
      }));
    }

    else if (msg.type === "set") {
      if (!ws.room) return;
      // role + accès + NON verrouillé (revérifié à chaque message)
      if (!canEditSheetNow(ws.user, ws.candidateId, ws.sheet)) return;
      const { candidateId, sheet } = ws;
      if (typeof msg.itemId !== "string" || !VALID_IDS[sheet].has(msg.itemId)) return;
      const checked = !!msg.checked;
      store.setEvaluation(candidateId, sheet, msg.itemId, checked);
      broadcastRoom(ws.room, { type: "update", itemId: msg.itemId, checked });
    }

    else if (msg.type === "comment") {
      if (!ws.room) return;
      if (!canEditSheetNow(ws.user, ws.candidateId, ws.sheet)) return;
      if (typeof msg.text !== "string") return;
      // Caractères de contrôle retirés (sauf tabulation et retours à la ligne) :
      // interdits dans le XML du classeur Excel, ils le rendraient illisible
      const text = msg.text.slice(0, 5000).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
      store.setComment(ws.candidateId, ws.sheet, text);
      // Diffuser aux AUTRES clients de la salle (pas l'émetteur, qui tape)
      broadcastRoom(ws.room, { type: "comment", text }, ws);
    }

    else if (msg.type === "bonus") {
      if (!ws.room) return;
      if (!canEditSheetNow(ws.user, ws.candidateId, ws.sheet)) return;
      // Bonus sur 2 points, borné [0, 2] ; NaN/Infinity/objets rejetés
      const n = Number(msg.bonus);
      if (!Number.isFinite(n)) return;
      const bonus = Math.max(0, Math.min(2, n));
      store.setBonus(ws.candidateId, ws.sheet, bonus);
      broadcastRoom(ws.room, { type: "bonus", bonus }, ws);
    }

    else if (msg.type === "noteOverride") {
      if (!ws.room) return;
      if (!canEditSheetNow(ws.user, ws.candidateId, ws.sheet)) return;
      // Vide -> efface la note définitive ; sinon nombre dans [0, 20]
      let value = null;
      if (!(msg.value === null || msg.value === undefined || msg.value === "")) {
        const n = Number(msg.value);
        if (!Number.isFinite(n) || n < 0 || n > 20) return; // invalide : ignoré
        value = Math.round(n * 100) / 100;
      }
      store.setNoteOverride(ws.candidateId, ws.sheet, value);
      broadcastRoom(ws.room, { type: "noteOverride", value }, ws);
    }
}

/* Diffusion aux autres membres d'une salle (candidat + onglet).
   Les droits de CHAQUE destinataire sont revérifiés : un juré retiré de sa
   commission, un enseignant retiré de sa classe ou une session fermée ne
   doivent plus recevoir les saisies en direct. */
function broadcastRoom(room, payload, except) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.room !== room || client === except) continue;
    if (!wsSessionValid(client)) continue;
    if (!canViewSheet(client.user, client.candidateId, client.sheet)) {
      client.room = null;
      client.send(JSON.stringify({ type: "revoked" }));
      continue;
    }
    client.send(data);
  }
}
// Message sans donnée (« la liste a changé, rechargez-la ») : à tous
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
// Verrouillage : seulement aux utilisateurs qui ont accès à ce candidat
function broadcastLockChanged(candidateId, sheet) {
  const data = JSON.stringify({ type: "lockchanged", candidateId, sheet });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.user && auth.canAccessCandidate(client.user, candidateId)) {
      client.send(data);
    }
  }
}

/* Ferme les WebSocket d'un utilisateur dont les sessions ont été révoquées
   (changement / réinitialisation de mot de passe, suppression du compte),
   sauf celle de la session exceptToken. Sans cela, une connexion déjà
   ouverte continuerait à pouvoir écrire malgré la révocation. */
function closeUserSockets(userId, exceptToken) {
  for (const client of wss.clients) {
    if (client.user && client.user.id === userId && client.user.token !== exceptToken) {
      try { client.close(4001, "Session fermée"); } catch {}
    }
  }
}
// Ferme les WebSocket d'une session précise (déconnexion)
function closeSessionSockets(token) {
  for (const client of wss.clients) {
    if (client.user && client.user.token === token) {
      try { client.close(4001, "Session fermée"); } catch {}
    }
  }
}

/* ════════════════ Démarrage ════════════════ */
store.purgeSessions();
const created = auth.ensureDefaultAdmin();

// Erreurs d'écoute (port privilégié, port déjà pris…) : message clair au lieu
// d'une pile d'erreur.
server.on("error", (err) => {
  if (err.code === "EACCES") {
    console.error(`\n  ✖ Permission refusée pour écouter sur le port ${PORT}.`);
    console.error(`    Sous Linux, les ports < 1024 sont réservés à root.`);
    console.error(`    Utilisez un port >= 1024 (ex. PORT=3000) derrière un reverse proxy,`);
    console.error(`    ou voir la section « Déploiement » du README.\n`);
  } else if (err.code === "EADDRINUSE") {
    console.error(`\n  ✖ Le port ${PORT} est déjà utilisé par un autre programme.`);
    console.error(`    Arrêtez-le ou choisissez un autre port (ex. PORT=3001).\n`);
  } else {
    console.error("\n  ✖ Erreur du serveur :", err.message, "\n");
  }
  process.exit(1);
});

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
    console.log(`    Changez ce mot de passe dès la première connexion (bouton « Mon compte »).`);
  }
  console.log("");
});
