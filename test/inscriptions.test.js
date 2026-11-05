/* ════════════════════════════════════════════════════════════════
   Tests : inscription des membres de commission, changement de mot
   de passe, limitation des tentatives.
   Lance le vrai serveur sur une base temporaire (DB_FILE) et un port
   libre, puis l'interroge par HTTP et WebSocket.
   Exécution : npm test
   ════════════════════════════════════════════════════════════════ */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let srv;                      // serveur de test
let admin;                    // client connecté en admin
const createdCandidates = []; // supprimés à la fin (fichiers Excel dans uploads/)

const client = () => h.client(srv.base);
const login = (u, p) => h.login(srv.base, u, p);
const openSocket = (c) => h.openSocket(srv.wsBase, c);
const nextMessage = h.nextMessage;

before(async () => {
  srv = await h.startServer();
  admin = await h.adminClient(srv); // mot de passe provisoire déjà remplacé
});

after(async () => {
  try {
    for (const id of createdCandidates) await admin("DELETE", `/api/candidates/${id}`);
  } finally {
    if (srv) await srv.stop();
  }
});

const JURE = { username: "jure.dupont", displayName: "Claire Dupont", password: "motdepasse-1" };

test("inscriptions fermées par défaut", async () => {
  const anon = client();
  assert.deepEqual((await anon("GET", "/api/registration")).data, { open: false });
  const r = await anon("POST", "/api/register", JURE);
  assert.equal(r.status, 403);
});

test("seul l'admin peut ouvrir les inscriptions", async () => {
  const anon = client();
  assert.equal((await anon("POST", "/api/registration", { open: true })).status, 401);
  assert.equal((await admin("POST", "/api/registration", { open: "oui" })).status, 400);
  const r = await admin("POST", "/api/registration", { open: true });
  assert.equal(r.status, 200);
  assert.deepEqual((await anon("GET", "/api/registration")).data, { open: true });
});

test("l'inscription crée toujours un compte commission, même si un autre rôle est demandé", async () => {
  const jure = client();
  const r = await jure("POST", "/api/register", { ...JURE, role: "admin" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, "commission");
  assert.deepEqual(r.data.allowedSheets, ["SO"]);
  // Connecté automatiquement
  const me = await jure("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, JURE.username);
  // Côté admin : marqué auto-inscrit, sans commission
  const users = (await admin("GET", "/api/users")).data;
  const u = users.find(x => x.username === JURE.username);
  assert.equal(u.selfRegistered, 1);
  assert.equal(u.commissionCount, 0);
  assert.ok(!("passwordHash" in u));
});

test("l'inscription valide identifiant, nom et mot de passe", async () => {
  const anon = client();
  const cases = [
    [{ ...JURE, username: "autre", password: "court" }, /8 caractères/],
    [{ ...JURE, username: "a b" }, /Identifiant invalide/],
    [{ ...JURE, username: "<script>" }, /Identifiant invalide/],
    [{ ...JURE, username: "ab" }, /Identifiant invalide/],
    [{ ...JURE, username: "élodie" }, /Identifiant invalide/],
    [{ ...JURE, username: "autre", displayName: "   " }, /Nom et prénom/],
    [{ ...JURE, username: "JURE.DUPONT" }, /déjà utilisé/], // unicité insensible à la casse
  ];
  for (const [body, expected] of cases) {
    const r = await anon("POST", "/api/register", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, expected);
  }
});

test("un juré non affecté ne voit aucun candidat, puis ses candidats une fois associé", async () => {
  const c = await admin("POST", "/api/candidates", { nom: "Martin", prenom: "Léa", numero: "" });
  assert.equal(c.status, 200);
  createdCandidates.push(c.data.id);

  const jure = await login(JURE.username, JURE.password);
  assert.deepEqual((await jure("GET", "/api/candidates")).data, []);
  const ev = await jure("GET", `/api/evaluation?candidateId=${c.data.id}&sheet=SO`);
  assert.equal(ev.status, 403);
  // WebSocket : abonnement refusé (aucune réponse)
  let ws = await openSocket(jure);
  ws.send(JSON.stringify({ type: "subscribe", candidateId: c.data.id, sheet: "SO" }));
  assert.equal(await nextMessage(ws), null);
  ws.close();

  // L'admin associe le juré et le candidat à une commission
  const com = await admin("POST", "/api/commissions", { name: "Commission A" });
  const jureId = (await admin("GET", "/api/users")).data.find(u => u.username === JURE.username).id;
  assert.equal((await admin("POST", `/api/commissions/${com.data.id}/members`, { userId: jureId })).status, 200);
  assert.equal((await admin("POST", `/api/commissions/${com.data.id}/candidates`, { candidateId: c.data.id })).status, 200);

  const list = (await jure("GET", "/api/candidates")).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c.data.id);
  ws = await openSocket(jure);
  ws.send(JSON.stringify({ type: "subscribe", candidateId: c.data.id, sheet: "SO" }));
  const msg = await nextMessage(ws, 2000);
  assert.equal(msg && msg.type, "state");
  assert.equal(msg.canEdit, true);
  ws.close();

  const u = (await admin("GET", "/api/users")).data.find(x => x.username === JURE.username);
  assert.equal(u.commissionCount, 1);
});

test("verrouillage du lot : un mauvais mot de passe renvoie 403 (et non 401)", async () => {
  const jure = await login(JURE.username, JURE.password);
  const r = await jure("POST", "/api/lock-batch", { password: "pas-le-bon" });
  assert.equal(r.status, 403);
  assert.equal((await jure("GET", "/api/me")).status, 200); // toujours connecté
});

test("inscriptions refusées une fois fermées", async () => {
  assert.equal((await admin("POST", "/api/registration", { open: false })).status, 200);
  const r = await client()("POST", "/api/register", { ...JURE, username: "retardataire" });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /fermées/);
});

test("changement de son propre mot de passe : ancien requis, autres sessions fermées", async () => {
  const a = await login(JURE.username, JURE.password);
  const b = await login(JURE.username, JURE.password);
  const wsB = await openSocket(b);
  const closed = new Promise(resolve => wsB.once("close", (code) => resolve(code)));

  let r = await a("POST", "/api/me/password", { currentPassword: "faux", newPassword: "nouveau-mdp-1" });
  assert.equal(r.status, 403);
  r = await a("POST", "/api/me/password", { currentPassword: JURE.password, newPassword: "court" });
  assert.equal(r.status, 400);
  r = await a("POST", "/api/me/password", { currentPassword: JURE.password, newPassword: JURE.password });
  assert.equal(r.status, 400);
  r = await a("POST", "/api/me/password", { currentPassword: JURE.password, newPassword: "nouveau-mdp-1" });
  assert.equal(r.status, 200);

  assert.equal((await a("GET", "/api/me")).status, 200);  // session courante conservée
  assert.equal((await b("GET", "/api/me")).status, 401);  // autre session fermée
  assert.equal(await closed, 4001);                        // et son WebSocket aussi
  assert.equal((await client()("POST", "/api/login", { username: JURE.username, password: JURE.password })).status, 401);
  await login(JURE.username, "nouveau-mdp-1");
  JURE.password = "nouveau-mdp-1";
});

test("un enseignant peut changer son mot de passe provisoire", async () => {
  let r = await admin("POST", "/api/users", { username: "prof1", displayName: "M. Prof", password: "court", role: "teacher" });
  assert.equal(r.status, 400); // 8 caractères minimum aussi côté admin
  r = await admin("POST", "/api/users", { username: "prof1", displayName: "M. Prof", password: "provisoire-1", role: "teacher" });
  assert.equal(r.status, 200);
  const prof = await login("prof1", "provisoire-1");
  // Mot de passe provisoire : tout est refusé tant qu'il n'est pas changé
  assert.equal((await prof("GET", "/api/me")).data.user.mustChangePassword, true);
  r = await prof("GET", "/api/candidates");
  assert.equal(r.status, 403);
  assert.equal(r.data.mustChangePassword, true);
  r = await prof("POST", "/api/me/password", { currentPassword: "provisoire-1", newPassword: "secret-du-prof" });
  assert.equal(r.status, 200);
  assert.equal((await prof("GET", "/api/candidates")).status, 200);
  await login("prof1", "secret-du-prof");
});

test("réinitialisation par l'admin : toutes les sessions du compte sont fermées", async () => {
  const jure = await login(JURE.username, JURE.password);
  const jureId = (await admin("GET", "/api/users")).data.find(u => u.username === JURE.username).id;
  assert.equal((await admin("POST", `/api/users/${jureId}/password`, { password: "court" })).status, 400);
  assert.equal((await admin("POST", `/api/users/${jureId}/password`, { password: "provisoire-2" })).status, 200);
  assert.equal((await jure("GET", "/api/me")).status, 401);
  const reconnecte = await login(JURE.username, "provisoire-2");
  // le mot de passe réinitialisé est provisoire : à changer avant toute autre action
  assert.equal((await reconnecte("GET", "/api/me")).data.user.mustChangePassword, true);
  assert.equal((await reconnecte("GET", "/api/candidates")).status, 403);
  assert.equal((await admin("GET", "/api/me")).status, 200); // l'admin reste connecté
});

test("connexion : blocage après 10 échecs pour un même identifiant", async () => {
  const anon = client();
  for (let i = 0; i < 10; i++) {
    const r = await anon("POST", "/api/login", { username: "inconnu", password: "x" });
    assert.equal(r.status, 401);
  }
  const r = await anon("POST", "/api/login", { username: "inconnu", password: "x" });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  // Les autres comptes ne sont pas bloqués
  await login("prof1", "secret-du-prof");
});

test("inscription : blocage après 30 tentatives depuis la même adresse", async () => {
  const anon = client();
  let attempts = 0, status = 0;
  while (attempts < 40) {
    attempts++;
    status = (await anon("POST", "/api/register", { username: "x", password: "y" })).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
  assert.ok(attempts <= 31, `bloqué après ${attempts} tentatives`);
});
