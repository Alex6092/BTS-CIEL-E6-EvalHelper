/* ════════════════════════════════════════════════════════════════
   Tests des renforcements : mot de passe initial de l'admin, mots de
   passe provisoires, limitation répartie, conservation des données,
   en-têtes de sécurité.
   Exécution : npm test
   ════════════════════════════════════════════════════════════════ */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const h = require("./helpers");
const { clientKey } = require("../ratelimit");

const DATA_DIR = path.join(__dirname, "..", "data");
const EXPORT_DIR = path.join(__dirname, "..", "exports");

let srv, admin;
const createdCandidates = [];
const client = () => h.client(srv.base);
const login = (u, p) => h.login(srv.base, u, p);

before(async () => {
  srv = await h.startServer();
  admin = await h.adminClient(srv);
});

after(async () => {
  try {
    for (const id of createdCandidates) await admin("DELETE", `/api/candidates/${id}`);
  } finally {
    if (srv) await srv.stop();
  }
});

/* ── H3 : compte admin initial ── */
test("H3 : premier lancement, mot de passe admin aléatoire et provisoire", async () => {
  const fresh = await h.startServer({ ADMIN_INITIAL_PASSWORD: "" });
  try {
    const m = fresh.output().match(/Compte administrateur créé : admin \/ (\S+)/);
    assert.ok(m, "mot de passe initial non affiché :\n" + fresh.output());
    const initial = m[1];
    assert.ok(initial.length >= 12 && initial !== "admin");
    assert.equal((await h.client(fresh.base)("POST", "/api/login", { username: "admin", password: "admin" })).status, 401);

    const a = await h.login(fresh.base, "admin", initial);
    assert.equal((await a("GET", "/api/me")).data.user.mustChangePassword, true);
    assert.equal((await a("GET", "/api/users")).status, 403);
    // WebSocket refusé tant que le mot de passe n'est pas changé
    const ws = await h.openSocket(fresh.wsBase, a);
    assert.equal(await h.closeCode(ws), 4003);

    const r = await a("POST", "/api/me/password", { currentPassword: initial, newPassword: "nouveau-mdp-admin" });
    assert.equal(r.status, 200);
    assert.equal((await a("GET", "/api/users")).status, 200);
  } finally {
    await fresh.stop();
  }
});

test("H3 : une installation existante avec admin/admin doit changer de mot de passe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6-test-legacy-"));
  const dbFile = path.join(dir, "legacy.db");
  try {
    // Base « ancienne » : compte admin/admin sans obligation de changement
    const first = await h.startServer({ DB_FILE: dbFile, ADMIN_INITIAL_PASSWORD: "admin" });
    await first.stop();
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET mustChangePassword = 0 WHERE username = 'admin'").run();
    db.close();

    const second = await h.startServer({ DB_FILE: dbFile });
    try {
      assert.match(second.output(), /mot de passe par défaut « admin »/);
      const a = await h.login(second.base, "admin", "admin");
      assert.equal((await a("GET", "/api/me")).data.user.mustChangePassword, true);
      assert.equal((await a("GET", "/api/candidates")).status, 403);
    } finally {
      await second.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("H3 : les comptes inscrits eux-mêmes n'ont pas de mot de passe provisoire", async () => {
  await admin("POST", "/api/registration", { open: true });
  const j = client();
  const r = await j("POST", "/api/register", { username: "inscrit", displayName: "Inscrit", password: "mon-mot-de-passe" });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.mustChangePassword, false);
  assert.equal((await j("GET", "/api/candidates")).status, 200);
  await admin("POST", "/api/registration", { open: false });
});

/* ── M6 : attaque répartie sur plusieurs adresses ── */
test("M6 : un compte est protégé même si les essais viennent d'adresses différentes", async () => {
  await admin("POST", "/api/users", { username: "cible", password: "provisoire-cible", role: "teacher" });
  for (let i = 1; i <= 10; i++) {
    const r = await client()("POST", "/api/login", { username: "cible", password: "faux" },
      { "X-Forwarded-For": `203.0.113.${i}` });
    assert.equal(r.status, 401);
  }
  const r = await client()("POST", "/api/login", { username: "cible", password: "faux" },
    { "X-Forwarded-For": "198.51.100.77" });
  assert.equal(r.status, 429);
  // Les autres comptes ne sont pas concernés
  assert.equal((await client()("POST", "/api/login", { username: "admin", password: h.ADMIN_PASSWORD },
    { "X-Forwarded-For": "198.51.100.78" })).status, 200);
});

test("M6 : les adresses IPv6 sont regroupées par bloc /64", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("::ffff:192.0.2.10"), "192.0.2.10");
  assert.equal(clientKey("192.0.2.10"), "192.0.2.10");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
});

/* ── L5 : identifiants devinables par le temps de réponse ── */
test("L5 : un identifiant inconnu répond aussi lentement qu'un compte existant", async () => {
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const timeLogin = async (username, ip) => {
    const t = process.hrtime.bigint();
    await client()("POST", "/api/login", { username, password: "faux-mot-de-passe" }, { "X-Forwarded-For": ip });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const known = [], unknown = [];
  for (let i = 0; i < 5; i++) {
    known.push(await timeLogin("admin", `192.0.2.${100 + i}`));
    unknown.push(await timeLogin(`inconnu-${i}-${crypto.randomBytes(3).toString("hex")}`, `192.0.2.${110 + i}`));
  }
  assert.ok(median(unknown) > median(known) * 0.5,
    `inconnu ${median(unknown).toFixed(1)} ms / existant ${median(known).toFixed(1)} ms`);
});

/* ── M7 : conservation des données ── */
test("M7 : les jetons de session ne sont pas enregistrés en clair", async () => {
  const token = admin.cookie().split("=")[1];
  const db = new Database(srv.dbFile, { readonly: true });
  try {
    const tokens = db.prepare("SELECT token FROM sessions").all().map(r => r.token);
    assert.ok(!tokens.includes(token));
    assert.ok(tokens.includes(crypto.createHash("sha256").update(token).digest("hex")));
  } finally {
    db.close();
  }
});

test("M7 : la base n'est lisible que par le compte de l'application", { skip: process.platform === "win32" }, () => {
  assert.equal(fs.statSync(srv.dbFile).mode & 0o777, 0o600);
});

test("M7 : un export est supprimé du serveur après son téléchargement", async () => {
  const c = (await admin("POST", "/api/candidates", { nom: "Export", prenom: "Unique" })).data;
  createdCandidates.push(c.id);
  const exp = await admin("POST", "/api/export-full", { candidateId: c.id });
  assert.equal(exp.status, 200);
  assert.ok(fs.existsSync(path.join(EXPORT_DIR, exp.data.fileName)));
  const first = await fetch(srv.base + exp.data.downloadUrl, { headers: { Cookie: admin.cookie() } });
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  await h.sleep(200);
  assert.ok(!fs.existsSync(path.join(EXPORT_DIR, exp.data.fileName)));
  const second = await fetch(srv.base + exp.data.downloadUrl, { headers: { Cookie: admin.cookie() } });
  assert.notEqual(second.status, 200);
});

test("M7 : la purge vide les exports et l'archive ne contient pas les sessions", async () => {
  const c = (await admin("POST", "/api/candidates", { nom: "Purge", prenom: "Test" })).data;
  const exp = await admin("POST", "/api/export-full", { candidateId: c.id }); // jamais téléchargé
  const r = await admin("POST", "/api/purge", { password: h.ADMIN_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const archivePath = path.join(DATA_DIR, r.data.archived);
  try {
    assert.ok(!fs.existsSync(path.join(EXPORT_DIR, exp.data.fileName)));
    const db = new Database(archivePath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0); // comptes conservés
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n >= 1); // données archivées
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  createdCandidates.length = 0; // tout a été supprimé par la purge
});

/* ── L8 : en-têtes de sécurité et cookie ── */
test("L8 : en-têtes de sécurité sur les pages et l'API", async () => {
  const page = await fetch(srv.base + "/");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const html = await page.text();
  assert.doesNotMatch(html, /\son[a-z]+="/i, "gestionnaire d'événement intégré au HTML (bloqué par la CSP)");
  const api = await fetch(srv.base + "/api/registration");
  assert.equal(api.headers.get("cache-control"), "no-store");
});

test("L8 : cookie « Secure » et HSTS quand le site est servi en HTTPS (via nginx)", async () => {
  const body = JSON.stringify({ username: "admin", password: h.ADMIN_PASSWORD });
  const headers = { "Content-Type": "application/json" };
  const https = await fetch(srv.base + "/api/login", { method: "POST", body, headers: { ...headers, "X-Forwarded-Proto": "https" } });
  assert.match(https.headers.get("set-cookie"), /; Secure/);
  assert.ok(https.headers.get("strict-transport-security"));
  const http = await fetch(srv.base + "/api/login", { method: "POST", body, headers });
  assert.doesNotMatch(http.headers.get("set-cookie"), /Secure/);
});
