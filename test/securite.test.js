/* ════════════════════════════════════════════════════════════════
   Tests de sécurité : chaque test rejoue une attaque relevée lors de
   l'audit et vérifie qu'elle échoue désormais.
   Exécution : npm test
   ════════════════════════════════════════════════════════════════ */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const h = require("./helpers");

let srv, admin, cand, com;
const ids = {};                  // identifiants des comptes créés
const createdCandidates = [];

const client = () => h.client(srv.base);
const login = (u, p) => h.login(srv.base, u, p);
const openSocket = (c, headers) => h.openSocket(srv.wsBase, c, headers);

/* Messages reçus pendant `ms` millisecondes */
function collect(ws, ms = 400) {
  return new Promise((resolve) => {
    const msgs = [];
    const onMsg = (raw) => msgs.push(JSON.parse(raw));
    ws.on("message", onMsg);
    setTimeout(() => { ws.off("message", onMsg); resolve(msgs); }, ms);
  });
}
/* Premier message qui satisfait `pred`, ou null */
function waitFor(ws, pred, ms = 1500) {
  return new Promise((resolve) => {
    const onMsg = (raw) => { const m = JSON.parse(raw); if (pred(m)) { done(m); } };
    const t = setTimeout(() => done(null), ms);
    function done(v) { clearTimeout(t); ws.off("message", onMsg); resolve(v); }
    ws.on("message", onMsg);
  });
}
async function subscribe(ws, candidateId, sheet) {
  ws.send(JSON.stringify({ type: "subscribe", candidateId, sheet }));
  return waitFor(ws, m => m.type === "state");
}
async function serverAlive() {
  await h.sleep(300);
  assert.ok(srv.alive(), "le serveur s'est arrêté :\n" + srv.output().slice(-800));
  const r = await client()("GET", "/api/registration");
  assert.equal(r.status, 200);
}

before(async () => {
  srv = await h.startServer();
  admin = await login("admin", "admin");
  cand = (await admin("POST", "/api/candidates", { nom: "Securite", prenom: "Test" })).data;
  createdCandidates.push(cand.id);
  com = (await admin("POST", "/api/commissions", { name: "Commission S" })).data;
  for (const [u, role] of [["j1", "commission"], ["j2", "commission"], ["jx", "commission"], ["t1", "teacher"]]) {
    const r = await admin("POST", "/api/users", { username: u, password: `motdepasse-${u}`, role });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids[u] = r.data.id;
  }
  for (const u of ["j1", "j2"]) await admin("POST", `/api/commissions/${com.id}/members`, { userId: ids[u] });
  await admin("POST", `/api/commissions/${com.id}/candidates`, { candidateId: cand.id });
});

after(async () => {
  try {
    for (const id of createdCandidates) await admin("DELETE", `/api/candidates/${id}`);
  } finally {
    if (srv) await srv.stop();
  }
});

/* ── H1 : cookie mal encodé ── */
test("H1 : un cookie mal encodé ne fait plus planter le serveur", async () => {
  // WebSocket anonyme avec un cookie invalide : refusé proprement (4001)
  const ws = await openSocket(null, { Cookie: "autre=%E0" });
  assert.equal(await h.closeCode(ws), 4001);
  await serverAlive();
  // HTTP : le cookie invalide d'une autre appli n'empêche pas la session
  const r = await fetch(srv.base + "/api/me", { headers: { Cookie: `autre=%E0; ${admin.cookie()}` } });
  assert.equal(r.status, 200);
});

/* ── H1-bis : trame WebSocket invalide ── */
test("H1-bis : une trame WebSocket invalide ne fait plus planter le serveur", async () => {
  await new Promise((resolve, reject) => {
    const s = net.connect(srv.port, "127.0.0.1", () => {
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
        `Cookie: ${admin.cookie()}\r\n\r\n`);
    });
    s.once("data", (d) => {
      assert.match(d.toString(), /^HTTP\/1.1 101/);
      s.write(Buffer.from([0xC1, 0x81, 1, 2, 3, 4, 0x40])); // bit RSV1 interdit
      setTimeout(() => { s.destroy(); resolve(); }, 300);
    });
    s.on("error", reject);
  });
  await serverAlive();
});

/* ── M5 : taille et nombre des messages ── */
test("M5 : un message WebSocket trop gros ferme la connexion, sans arrêter le serveur", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const ws = await openSocket(j1);
  ws.send("x".repeat(100 * 1024));
  assert.equal(await h.closeCode(ws), 1009); // « message too big »
  await serverAlive();
});

test("M5 : un flot de messages ferme la connexion", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const ws = await openSocket(j1);
  for (let i = 0; i < 320; i++) ws.send("{}");
  assert.equal(await h.closeCode(ws), 1008);
});

/* ── M1 : WebSocket ouvert depuis une autre page ── */
test("M1 : connexion WebSocket refusée si elle vient d'un autre site", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  await assert.rejects(openSocket(j1, { Origin: "http://evil.example" }), /HTTP 403/);
  await assert.rejects(openSocket(j1, { Origin: `http://127.0.0.1:${srv.port + 1}` }), /HTTP 403/); // autre port
  await assert.rejects(openSocket(j1, { "Sec-Fetch-Site": "same-site" }), /HTTP 403/);
  const ok = await openSocket(j1, { Origin: `http://127.0.0.1:${srv.port}`, "Sec-Fetch-Site": "same-origin" });
  ok.close();
});

/* ── M2 : requêtes d'écriture forgées ── */
test("M2 : requête d'écriture refusée si elle vient d'un autre site", async () => {
  const body = { open: false };
  let r = await admin("POST", "/api/registration", body, { Origin: "http://evil.example" });
  assert.equal(r.status, 403);
  r = await admin("POST", "/api/registration", body, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(r.status, 403);
  r = await admin("POST", "/api/registration", body, { "Sec-Fetch-Site": "same-site" });
  assert.equal(r.status, 403);
  r = await admin("POST", "/api/logout", undefined, { Origin: "null" });
  assert.equal(r.status, 403);
  // Depuis l'application elle-même : accepté
  r = await admin("POST", "/api/registration", body, { Origin: `http://127.0.0.1:${srv.port}`, "Sec-Fetch-Site": "same-origin" });
  assert.equal(r.status, 200);
});

test("M2 : la purge exige le mot de passe de l'admin", async () => {
  assert.equal((await admin("POST", "/api/purge")).status, 400);
  assert.equal((await admin("POST", "/api/purge", { password: "pas-le-bon" })).status, 403);
  assert.equal((await admin("GET", "/api/me")).status, 200); // toujours connecté
  assert.equal((await admin("GET", "/api/candidates")).data.length, 1); // rien n'a été supprimé
});

/* ── M3 : connexions WebSocket déjà ouvertes ── */
test("M3 : la déconnexion ferme le WebSocket de la session", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const ws = await openSocket(j1);
  await subscribe(ws, cand.id, "SO");
  const closed = h.closeCode(ws, 2000);
  await j1("POST", "/api/logout");
  assert.equal(await closed, 4001);
});

test("M3 : un juré retiré de sa commission ne reçoit plus les saisies en direct", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const j2 = await login("j2", "motdepasse-j2");
  const w1 = await openSocket(j1), w2 = await openSocket(j2);
  assert.equal((await subscribe(w1, cand.id, "SO")).canEdit, true);
  assert.equal((await subscribe(w2, cand.id, "SO")).canEdit, true);

  await admin("DELETE", `/api/commissions/${com.id}/members/${ids.j2}`);
  const received = collect(w2, 600);
  w1.send(JSON.stringify({ type: "comment", text: "Commentaire confidentiel" }));
  const msgs = await received;
  assert.ok(!msgs.some(m => m.type === "comment"), "le commentaire a été reçu : " + JSON.stringify(msgs));
  assert.ok(msgs.some(m => m.type === "revoked"));
  // et il ne peut plus écrire
  w2.send(JSON.stringify({ type: "set", itemId: "C01-1-1", checked: true }));
  await h.sleep(200);
  const ev = await (await login("j1", "motdepasse-j1"))("GET", `/api/evaluation?candidateId=${cand.id}&sheet=SO`);
  assert.notEqual(ev.data.state["C01-1-1"], true);
  w1.close(); w2.close();
  await admin("POST", `/api/commissions/${com.id}/members`, { userId: ids.j2 }); // remis pour la suite
});

/* ── L1 : note définitive de soutenance avant verrouillage ── */
test("L1 : avant verrouillage, l'établissement ne sait pas si une note définitive SO est saisie", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const ws = await openSocket(j1);
  await subscribe(ws, cand.id, "SO");
  ws.send(JSON.stringify({ type: "noteOverride", value: 15 }));
  await h.sleep(200);
  ws.close();
  const c = (await admin("GET", "/api/candidates")).data.find(x => x.id === cand.id);
  assert.equal(c.notes.SO, null);
  assert.equal(c.overrides.SO, false);
});

/* ── L3 : caractères de contrôle dans un commentaire ── */
test("L3 : un caractère de contrôle dans un commentaire ne corrompt pas l'export Excel", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const ws = await openSocket(j1);
  await subscribe(ws, cand.id, "SO");
  ws.send(JSON.stringify({ type: "comment", text: "Avant\u0001\u000BAprès" }));
  await h.sleep(200);
  ws.close();
  const exp = await j1("POST", "/api/export", { candidateId: cand.id, sheet: "SO" });
  assert.equal(exp.status, 200, JSON.stringify(exp.data));
  // L4 : nom de fichier imprévisible
  assert.match(exp.data.fileName, /_[0-9a-f]{12}\.xlsx$/);
  const file = await fetch(srv.base + exp.data.downloadUrl, { headers: { Cookie: j1.cookie() } });
  assert.equal(file.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await file.arrayBuffer()));
  let found = false;
  for (const name of Object.keys(zip.files).filter(n => /^xl\/worksheets\/.*\.xml$/.test(n))) {
    const xml = await zip.file(name).async("string");
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, name);
    if (xml.includes("AvantAprès")) found = true;
  }
  assert.ok(found, "commentaire absent de l'export");
});

/* ── L2 : notifications de verrouillage ── */
test("L2 : le verrouillage n'est notifié qu'aux utilisateurs ayant accès au candidat", async () => {
  const j1 = await login("j1", "motdepasse-j1");
  const jx = await login("jx", "motdepasse-jx");     // juré sans commission
  const t1 = await login("t1", "motdepasse-t1");     // enseignant d'aucune classe
  const w1 = await openSocket(j1), wx = await openSocket(jx), wt = await openSocket(t1);
  const [m1, mx, mt] = [collect(w1, 600), collect(wx, 600), collect(wt, 600)];
  const r = await j1("POST", "/api/lock", { candidateId: cand.id, sheet: "SO" });
  assert.equal(r.status, 200);
  assert.ok((await m1).some(m => m.type === "lockchanged"));
  assert.ok(!(await mx).some(m => m.type === "lockchanged"));
  assert.ok(!(await mt).some(m => m.type === "lockchanged"));
  w1.close(); wx.close(); wt.close();
  // L1 (suite) : une fois verrouillée, la note définitive est visible
  const c = (await admin("GET", "/api/candidates")).data.find(x => x.id === cand.id);
  assert.equal(c.overrides.SO, true);
  assert.equal(c.notes.SO, 15);
});

/* ── Upload : identifiant piégé dans l'URL ── */
test("Upload : un identifiant contenant « ../ » n'écrit rien hors du dossier uploads", async () => {
  const publicDir = path.join(__dirname, "..", "public");
  const before = fs.readdirSync(publicDir);
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("PK")]), "piege.xlsx");
  const r = await fetch(srv.base + "/api/candidates/x%2F..%2F..%2Fpublic%2Fpiege/excel", {
    method: "POST", body: fd, headers: { Cookie: admin.cookie() },
  });
  assert.equal(r.status, 404);
  assert.deepEqual(fs.readdirSync(publicDir), before);
});
