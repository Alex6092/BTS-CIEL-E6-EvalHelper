/* ════════════════════════════════════════════════════════════════
   Outils communs aux tests : démarre le vrai serveur sur une base
   temporaire et un port libre, client HTTP avec cookie, WebSocket.
   ════════════════════════════════════════════════════════════════ */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* Démarre server.js ; retourne { base, wsBase, port, output(), stop() } */
async function startServer(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e6-test-"));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DB_FILE: path.join(tmpDir, "test.db"), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", d => { out += d; });
  proc.stderr.on("data", d => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Le serveur n'a pas démarré :\n" + out)), 10000);
    const check = () => { if (out.includes("démarré")) { clearTimeout(timer); resolve(); } };
    proc.stdout.on("data", check);
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Serveur arrêté (code ${code}) :\n${out}`)); });
  });
  return {
    port, tmpDir, proc,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    output: () => out,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    async stop() {
      // Attendre l'arrêt effectif : sous Windows, la base reste verrouillée
      // tant que le processus tourne (suppression -> EPERM)
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise(resolve => proc.once("exit", resolve));
        proc.kill();
        await exited;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/* Client HTTP minimal avec cookie de session */
function client(base) {
  let cookie = "";
  const call = async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + url, {
      method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
  call.cookie = () => cookie;
  return call;
}

async function login(base, username, password) {
  const c = client(base);
  const r = await c("POST", "/api/login", { username, password });
  assert.equal(r.status, 200, `connexion de ${username} : ${JSON.stringify(r.data)}`);
  return c;
}

/* Ouvre un WebSocket avec le cookie du client (et d'éventuels en-têtes) */
function openSocket(wsBase, c, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase, { headers: { ...(c ? { Cookie: c.cookie() } : {}), ...headers } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error("HTTP " + res.statusCode)));
  });
}

/* Prochain message reçu, ou null après `ms` millisecondes */
function nextMessage(ws, ms = 500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { ws.off("message", onMsg); resolve(null); }, ms);
    function onMsg(raw) { clearTimeout(t); resolve(JSON.parse(raw)); }
    ws.once("message", onMsg);
  });
}

/* Code de fermeture du WebSocket, ou null s'il est encore ouvert après `ms` */
function closeCode(ws, ms = 1000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve("déjà fermé");
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    ws.once("close", (code) => { clearTimeout(t); resolve(code); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, client, login, openSocket, nextMessage, closeCode, sleep };
