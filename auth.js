/* ════════════════════════════════════════════════════════════════
   auth.js  —  Authentification : hash scrypt, sessions, rôles
   Rôles :
   - admin      : tout (comptes, commissions, paramètres, candidats…)
   - teacher    : tous les candidats, tous les onglets, export complet
   - commission : candidats de ses commissions, onglet SO uniquement
   ════════════════════════════════════════════════════════════════ */
const crypto = require("crypto");
const { promisify } = require("util");
const store = require("./db");

const scrypt = promisify(crypto.scrypt);

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

/* ── Mots de passe (scrypt) ──
   Version asynchrone : le calcul (volontairement coûteux) se fait hors du
   fil principal, le serveur continue de répondre aux autres requêtes. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(String(password), salt, 32);
  return salt + ":" + hash.toString("hex");
}

async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = await scrypt(String(password), salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* Empreinte factice : pour un identifiant inconnu, on vérifie quand même le
   mot de passe contre elle, afin que la réponse prenne le même temps que pour
   un compte existant (sinon on peut deviner quels identifiants existent). */
const DUMMY_HASH = crypto.randomBytes(16).toString("hex") + ":" + crypto.randomBytes(32).toString("hex");

/* ── Sessions ──
   Le jeton n'existe en clair que dans le cookie du navigateur ; la base
   n'en garde que l'empreinte SHA-256. Une copie de la base (sauvegarde,
   archive) ne permet donc pas de se connecter à la place de quelqu'un. */
const TOKEN_RE = /^[0-9a-f]{64}$/; // jeton de session : 32 octets en hexadécimal
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  store.addSession(tokenHash(token), userId, expires.toISOString().replace("T", " ").slice(0, 19));
  return token;
}

// Session encore valide (non supprimée, non expirée) ? Retourne sa ligne ou null
function getSession(token) {
  return TOKEN_RE.test(String(token)) ? store.getSession(tokenHash(token)) || null : null;
}
function destroySession(token) {
  if (TOKEN_RE.test(String(token))) store.deleteSession(tokenHash(token));
}
// Ferme toutes les sessions d'un utilisateur, sauf éventuellement exceptToken
function destroyUserSessions(userId, exceptToken) {
  store.deleteUserSessions(userId, exceptToken ? tokenHash(exceptToken) : undefined);
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

// Récupère l'utilisateur de session depuis une requête (Express ou WS upgrade)
function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const s = getSession(token);
  if (!s) return null;
  return {
    id: s.userId, username: s.username, displayName: s.displayName, role: s.role,
    mustChangePassword: !!s.mustChangePassword, token,
  };
}

// ── Middlewares Express ──
/* Tant que le mot de passe est provisoire (fixé par l'admin), seules les
   routes du compte (me, changement de mot de passe, déconnexion) sont
   accessibles : l'utilisateur doit d'abord choisir son propre mot de passe. */
function mustChangeResponse(res) {
  return res.status(403).json({
    error: "Vous devez d'abord remplacer votre mot de passe provisoire (« Mon compte »).",
    mustChangePassword: true,
  });
}

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Authentification requise." });
  if (user.mustChangePassword) return mustChangeResponse(res);
  req.user = user;
  next();
}

// Variante pour les routes du compte : accessible même avec un mot de passe provisoire
function requireAuthAllowProvisional(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Authentification requise." });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: "Authentification requise." });
    if (user.mustChangePassword) return mustChangeResponse(res);
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

/* ── Compte admin au premier lancement ──
   Mot de passe initial : variable d'environnement ADMIN_INITIAL_PASSWORD, ou
   à défaut un mot de passe aléatoire affiché une seule fois dans la console.
   Dans les deux cas, il est provisoire : à changer à la première connexion. */
async function ensureDefaultAdmin() {
  if (store.countAdmins() > 0) return null;
  const password = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(9).toString("base64url");
  store.addUser("admin", await hashPassword(password), "Administrateur", "admin", { mustChangePassword: true });
  return { username: "admin", password };
}

/* Installations existantes : si le compte « admin » a encore le mot de passe
   historique « admin », il est marqué « à changer ». Retourne true si c'est le cas. */
async function flagLegacyDefaultAdmin() {
  const u = store.getUserByName("admin");
  if (!u || u.mustChangePassword) return false;
  if (!(await verifyPassword("admin", u.passwordHash))) return false;
  store.setMustChangePassword(u.id, true);
  return true;
}

module.exports = {
  COOKIE_NAME,
  PASSWORD_MIN, USERNAME_RE, USERNAME_RULE, checkNewPassword,
  hashPassword, verifyPassword, DUMMY_HASH,
  createSession, getSession, destroySession, destroyUserSessions, userFromRequest,
  requireAuth, requireAuthAllowProvisional, requireRole,
  allowedSheets, canAccessSheet, canEditSheet, canAccessCandidate,
  ensureDefaultAdmin, flagLegacyDefaultAdmin,
};
