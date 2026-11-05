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

// ── Règles des identifiants et des nouveaux mots de passe ──
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 500;
// Identifiant choisi à l'inscription : ASCII uniquement (pas d'espace, pas de
// caractère trompeur ou interprétable en HTML)
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
const USERNAME_RULE = "3 à 50 caractères : lettres sans accent, chiffres, point, tiret ou tiret bas.";

// Retourne un message d'erreur, ou null si le nouveau mot de passe est acceptable
function checkNewPassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  }
  if (password.length > PASSWORD_MAX) return "Mot de passe trop long.";
  return null;
}

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

/* Lecture des cookies : l'en-tête Cookie est contrôlé par le client (et
   partagé avec les autres applications du même hôte). Une valeur mal encodée
   est ignorée : decodeURIComponent lève une exception qui, non rattrapée,
   faisait planter le serveur (connexion WebSocket) ou renvoyait 400. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorée */ }
  }
  return out;
}

const TOKEN_RE = /^[0-9a-f]{64}$/; // jeton de session : 32 octets en hexadécimal

// Récupère l'utilisateur de session depuis une requête (Express ou WS upgrade)
function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || !TOKEN_RE.test(token)) return null;
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
  PASSWORD_MIN, USERNAME_RE, USERNAME_RULE, checkNewPassword,
  hashPassword, verifyPassword,
  createSession, userFromRequest,
  requireAuth, requireRole,
  allowedSheets, canAccessSheet, canEditSheet, canAccessCandidate,
  ensureDefaultAdmin,
};
