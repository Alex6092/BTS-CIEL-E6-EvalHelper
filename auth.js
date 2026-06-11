/* ════════════════════════════════════════════════════════════════
   auth.js  —  Authentification : hash scrypt, sessions, rôles
   Rôles :
   - admin      : tout (comptes, commissions, paramètres, candidats…)
   - teacher    : tous les candidats, tous les onglets, export complet
   - commission : candidats de ses commissions, onglet SO uniquement
   ════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const store = require("./db");

const SESSION_DAYS = 7;
const COOKIE_NAME = "e6session";

// ── Mots de passe (scrypt) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ── Sessions ──
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  store.addSession(token, userId, expires.toISOString().replace("T", " ").slice(0, 19));
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Récupère l'utilisateur de session depuis une requête (Express ou WS upgrade)
function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const s = store.getSession(token);
  if (!s) return null;
  return { id: s.userId, username: s.username, displayName: s.displayName, role: s.role, token };
}

// ── Middlewares Express ──
function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Authentification requise." });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: "Authentification requise." });
    if (!roles.includes(user.role)) return res.status(403).json({ error: "Accès refusé." });
    req.user = user;
    next();
  };
}

// ── Règles d'accès métier ──
function allowedSheets(user) {
  return user.role === "commission" ? ["SO"] : ["STAGE", "R1", "R2", "R3", "SO"];
}

function canAccessSheet(user, sheetKey) {
  return allowedSheets(user).includes(sheetKey);
}

/* Écriture (saisie, commentaire, bonus) :
   - SO : UNIQUEMENT les membres de commission (le jury externe ne doit
     pas pouvoir être « corrigé » par l'établissement, même par un admin)
   - autres onglets : enseignants et admin */
function canEditSheet(user, sheetKey) {
  if (sheetKey === "SO") return user.role === "commission";
  return user.role === "admin" || user.role === "teacher";
}

function canAccessCandidate(user, candidateId) {
  if (user.role === "admin") return true;
  if (user.role === "teacher") return store.teacherCanSeeCandidate(user.id, Number(candidateId));
  return store.commissionCanSeeCandidate(user.id, Number(candidateId));
}

// ── Compte admin par défaut au premier lancement ──
function ensureDefaultAdmin() {
  if (store.countAdmins() > 0) return null;
  const password = "admin";
  store.addUser("admin", hashPassword(password), "Administrateur", "admin");
  return { username: "admin", password };
}

module.exports = {
  COOKIE_NAME,
  hashPassword, verifyPassword,
  createSession, userFromRequest,
  requireAuth, requireRole,
  allowedSheets, canAccessSheet, canEditSheet, canAccessCandidate,
  ensureDefaultAdmin,
};
