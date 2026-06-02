/* ════════════════════════════════════════════════════════════════
   app.js  —  Client : candidats, saisie collaborative, export Excel
   ════════════════════════════════════════════════════════════════ */
const { computeLevel } = window.HIERARCHY_DATA;
let HIERARCHY = [];
let SHEETS = {};

// État courant
let current = { candidate: null, sheet: null };
let state = {};           // { itemId: bool } pour le candidat+onglet courant
let ws = null;
let wsReady = false;

/* ════════════════ Helpers DOM ════════════════ */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), 3200);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  return data;
}

/* ════════════════ Initialisation ════════════════ */
(async function init() {
  const data = await api("/api/hierarchy");
  HIERARCHY = data.hierarchy;
  SHEETS = data.sheets;
  // Remplir le sélecteur d'onglets
  const sel = $("#sheet-select");
  for (const [key, name] of Object.entries(SHEETS)) {
    const o = el("option"); o.value = key; o.textContent = name; sel.appendChild(o);
  }
  connectWS();
  await loadCandidates();
  bindUI();
})();

/* ════════════════ WebSocket ════════════════ */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    wsReady = true;
    $("#conn-status").textContent = "● En ligne";
    $("#conn-status").classList.add("online");
    // Re-souscrire si on était en saisie
    if (current.candidate && current.sheet) subscribe();
  };
  ws.onclose = () => {
    wsReady = false;
    $("#conn-status").textContent = "● Hors ligne";
    $("#conn-status").classList.remove("online");
    setTimeout(connectWS, 1500); // reconnexion auto
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      state = msg.state || {};
      renderGridState();
    } else if (msg.type === "update") {
      // Mise à jour venue d'un autre client (ou confirmation)
      state[msg.itemId] = msg.checked;
      applyLeafUpdate(msg.itemId);
    } else if (msg.type === "candidates") {
      loadCandidates();
    }
  };
}

function subscribe() {
  if (!wsReady) return;
  ws.send(JSON.stringify({
    type: "subscribe",
    candidateId: current.candidate.id,
    sheet: current.sheet,
  }));
}

function sendSet(itemId, checked) {
  if (!wsReady) { toast("Hors ligne — modification non synchronisée", "error"); return; }
  ws.send(JSON.stringify({
    type: "set",
    candidateId: current.candidate.id,
    sheet: current.sheet,
    itemId, checked,
  }));
}

/* ════════════════ Écran candidats ════════════════ */
async function loadCandidates() {
  const list = await api("/api/candidates");
  const box = $("#candidate-list");
  box.innerHTML = "";
  if (!list.length) {
    const e = el("div", "empty-state");
    e.textContent = "Aucun candidat. Cliquez sur « + Ajouter un candidat ».";
    box.appendChild(e);
    return;
  }
  for (const c of list) box.appendChild(candidateCard(c));
}

function candidateCard(c) {
  const card = el("div", "candidate-card");

  const info = el("div", "info");
  const name = el("div", "name"); name.textContent = `${c.nom} ${c.prenom}`;
  const meta = el("div", "meta"); meta.textContent = c.numero ? "N° " + c.numero : "—";
  const tag = el("span", "excel-tag " + (c.hasExcel ? "ok" : "no"));
  tag.textContent = c.hasExcel ? "📎 " + (c.excelName || "Excel associé") : "⚠ Aucun fichier Excel";
  info.append(name, meta, tag);

  const actions = el("div", "actions");

  const bGrade = el("button", "btn btn-primary btn-sm"); bGrade.textContent = "Noter";
  bGrade.onclick = () => openGrading(c);

  const bExcel = el("button", "btn btn-outline btn-sm");
  bExcel.textContent = c.hasExcel ? "Changer Excel" : "Associer Excel";
  bExcel.onclick = () => associateExcel(c);

  const bDel = el("button", "btn btn-danger btn-sm"); bDel.textContent = "🗑";
  bDel.title = "Supprimer";
  bDel.onclick = () => deleteCandidate(c);

  actions.append(bGrade, bExcel, bDel);
  card.append(info, actions);
  return card;
}

function associateExcel(c) {
  const input = $("#excel-input");
  input.value = "";
  input.onchange = async () => {
    if (!input.files.length) return;
    const fd = new FormData();
    fd.append("file", input.files[0]);
    try {
      await api(`/api/candidates/${c.id}/excel`, { method: "POST", body: fd });
      toast("Fichier Excel associé ✓", "success");
    } catch (e) { toast(e.message, "error"); }
  };
  input.click();
}

async function deleteCandidate(c) {
  if (!confirm(`Supprimer ${c.nom} ${c.prenom} et toutes ses évaluations ?`)) return;
  try {
    await api(`/api/candidates/${c.id}`, { method: "DELETE" });
    toast("Candidat supprimé", "success");
  } catch (e) { toast(e.message, "error"); }
}

function bindUI() {
  $("#btn-toggle-add").onclick = () => $("#add-form").classList.toggle("open");

  $("#add-form").onsubmit = async (e) => {
    e.preventDefault();
    const nom = $("#in-nom").value.trim();
    const prenom = $("#in-prenom").value.trim();
    const numero = $("#in-numero").value.trim();
    if (!nom || !prenom) return;
    try {
      await api("/api/candidates", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom, prenom, numero }),
      });
      $("#in-nom").value = $("#in-prenom").value = $("#in-numero").value = "";
      $("#add-form").classList.remove("open");
      toast("Candidat ajouté ✓", "success");
    } catch (e) { toast(e.message, "error"); }
  };

  $("#btn-back").onclick = () => {
    current = { candidate: null, sheet: null };
    $("#screen-grading").classList.add("hidden");
    $("#screen-candidates").classList.remove("hidden");
    loadCandidates();
  };

  $("#sheet-select").onchange = () => {
    current.sheet = $("#sheet-select").value;
    subscribe(); // recharge l'état de l'autre onglet
  };

  $("#btn-export").onclick = exportExcel;
}

/* ════════════════ Écran saisie ════════════════ */
function openGrading(c) {
  current.candidate = c;
  current.sheet = $("#sheet-select").value || Object.keys(SHEETS)[0];
  $("#sheet-select").value = current.sheet;
  $("#g-name").textContent = `${c.nom} ${c.prenom}`;
  $("#g-meta").textContent = (c.numero ? "N° " + c.numero + " · " : "") +
    (c.hasExcel ? "Excel : " + (c.excelName || "associé") : "⚠ aucun Excel associé");

  $("#screen-candidates").classList.add("hidden");
  $("#screen-grading").classList.remove("hidden");

  buildGrid();
  subscribe();
}

// Construit la grille (une seule fois par ouverture)
function buildGrid() {
  const app = $("#app");
  app.innerHTML = "";

  HIERARCHY.forEach(section => {
    const card = el("div", "section-card"); card.id = "card-" + section.id;

    const hdr = el("div", "section-header");
    hdr.innerHTML = `<h2>${section.title}</h2>
      <span class="section-badge" id="badge-${section.id}">0 / 0</span>
      <span class="section-toggle-icon">▾</span>`;
    hdr.onclick = () => card.classList.toggle("collapsed");
    card.appendChild(hdr);

    const pbar = el("div", "section-progress-bar");
    pbar.innerHTML = `<div class="section-progress-fill" id="spfill-${section.id}" style="width:0%"></div>`;
    card.appendChild(pbar);

    const body = el("div", "section-body");

    section.items.forEach(item => {
      const pDiv = el("div", "parent-item" + (item.savoirEtre ? " savoir-etre" : ""));
      const row = el("div", "parent-label-row");

      const cb = el("input"); cb.type = "checkbox"; cb.id = "cb-" + item.id;
      cb.onchange = () => onParentToggle(item, cb.checked);

      const dot = el("span", "status-dot"); dot.id = "dot-" + item.id;

      const label = el("label", "parent-text"); label.htmlFor = "cb-" + item.id;
      label.textContent = item.savoirEtre ? "⭐ " + item.text : item.text;

      const lvl = el("span", "lvl-tag"); lvl.id = "lvl-" + item.id;

      row.append(cb, dot, label, lvl);

      const btn = el("button", "toggle-children");
      btn.textContent = "▾"; btn.title = "Afficher / masquer les sous-critères";
      btn.setAttribute("aria-expanded", "true");
      btn.onclick = (e) => {
        e.stopPropagation();
        const cl = pDiv.querySelector(".children-list");
        const expanded = btn.getAttribute("aria-expanded") === "true";
        cl.style.display = expanded ? "none" : "flex";
        btn.setAttribute("aria-expanded", String(!expanded));
        btn.textContent = expanded ? "▸" : "▾";
      };
      row.appendChild(btn);
      pDiv.appendChild(row);

      const ul = el("div", "children-list");
      (item.children || []).forEach(child => {
        const li = el("div", "child-item");
        const ccb = el("input"); ccb.type = "checkbox"; ccb.id = "cb-" + child.id;
        ccb.onclick = (e) => e.stopPropagation();
        ccb.onchange = () => onChildToggle(item, child, ccb.checked);
        const span = el("span", "child-text"); span.textContent = child.text;
        li.onclick = () => { ccb.checked = !ccb.checked; onChildToggle(item, child, ccb.checked); };
        li.append(ccb, span);
        ul.appendChild(li);
      });
      pDiv.appendChild(ul);
      body.appendChild(pDiv);
    });

    card.appendChild(body);
    app.appendChild(card);
  });
}

/* ── Toggle handlers (envoient au serveur) ── */
function onParentToggle(item, checked) {
  (item.children || []).forEach(child => {
    state[child.id] = checked;
    const ccb = document.getElementById("cb-" + child.id);
    if (ccb) ccb.checked = checked;
    updateChildText(child.id, checked);
    sendSet(child.id, checked);
  });
  refreshParent(item);
  refreshSection(sectionOf(item.id));
  refreshGlobal();
}

function onChildToggle(item, child, checked) {
  state[child.id] = checked;
  updateChildText(child.id, checked);
  sendSet(child.id, checked);
  refreshParent(item);
  refreshSection(sectionOf(item.id));
  refreshGlobal();
}

/* ── Mise à jour reçue du serveur (autre client) ── */
function applyLeafUpdate(itemId) {
  const ccb = document.getElementById("cb-" + itemId);
  if (ccb) ccb.checked = !!state[itemId];
  updateChildText(itemId, !!state[itemId]);
  const item = parentOf(itemId);
  if (item) {
    refreshParent(item);
    refreshSection(sectionOf(item.id));
    refreshGlobal();
  }
}

/* ── Rendu complet de l'état (après 'state' du serveur) ── */
function renderGridState() {
  HIERARCHY.forEach(section => {
    section.items.forEach(item => {
      (item.children || []).forEach(child => {
        const ccb = document.getElementById("cb-" + child.id);
        if (ccb) ccb.checked = !!state[child.id];
        updateChildText(child.id, !!state[child.id]);
      });
      refreshParent(item);
    });
    refreshSection(section.id);
  });
  refreshGlobal();
}

/* ── Helpers d'affichage ── */
function updateChildText(childId, checked) {
  const ccb = document.getElementById("cb-" + childId);
  if (!ccb) return;
  const li = ccb.closest(".child-item");
  const s = li && li.querySelector(".child-text");
  if (s) s.classList.toggle("checked-text", checked);
}

function refreshParent(item) {
  const total = (item.children || []).length;
  const checked = (item.children || []).filter(c => state[c.id]).length;
  const { color, level } = computeLevel(checked, total);

  const dot = document.getElementById("dot-" + item.id);
  if (dot) dot.className = "status-dot dot-" + color;

  const lvl = document.getElementById("lvl-" + item.id);
  if (lvl) lvl.textContent = `Niv. ${level} (${checked}/${total})`;

  const pcb = document.getElementById("cb-" + item.id);
  const label = document.querySelector(`label[for="cb-${item.id}"]`);
  if (pcb) {
    if (checked === 0) { pcb.checked = false; pcb.classList.remove("indeterminate"); }
    else if (checked === total) { pcb.checked = true; pcb.classList.remove("indeterminate"); }
    else { pcb.checked = false; pcb.classList.add("indeterminate"); }
  }
  if (label) label.classList.toggle("checked-text", checked === total && total > 0);
}

function refreshSection(sectionId) {
  const section = HIERARCHY.find(s => s.id === sectionId);
  if (!section) return;
  let total = 0, done = 0;
  section.items.forEach(item => (item.children || []).forEach(c => {
    total++; if (state[c.id]) done++;
  }));
  const pct = total ? Math.round(done / total * 100) : 0;
  const fill = document.getElementById("spfill-" + sectionId);
  const badge = document.getElementById("badge-" + sectionId);
  if (fill) fill.style.width = pct + "%";
  if (badge) { badge.textContent = done + " / " + total; badge.classList.toggle("done", done === total && total > 0); }
}

function refreshGlobal() {
  let total = 0, done = 0;
  HIERARCHY.forEach(s => s.items.forEach(item => (item.children || []).forEach(c => {
    total++; if (state[c.id]) done++;
  })));
  const pct = total ? Math.round(done / total * 100) : 0;
  $("#global-fill").style.width = pct + "%";
  $("#global-percent").textContent = pct;
}

/* ── Recherche d'éléments ── */
function sectionOf(itemId) {
  for (const s of HIERARCHY) if (s.items.find(i => i.id === itemId)) return s.id;
  return null;
}
function parentOf(childId) {
  for (const s of HIERARCHY) for (const item of s.items)
    if ((item.children || []).find(c => c.id === childId)) return item;
  return null;
}

/* ── Déplier / replier ── */
function expandAll() { document.querySelectorAll(".section-card").forEach(c => c.classList.remove("collapsed")); }
function collapseAll() { document.querySelectorAll(".section-card").forEach(c => c.classList.add("collapsed")); }

/* ════════════════ Export Excel ════════════════ */
async function exportExcel() {
  if (!current.candidate) return;
  if (!current.candidate.hasExcel) {
    toast("Associez d'abord un fichier Excel à ce candidat.", "error");
    return;
  }
  try {
    toast("Génération en cours…");
    const res = await api("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: current.candidate.id, sheet: current.sheet }),
    });
    // Déclencher le téléchargement
    const a = document.createElement("a");
    a.href = res.downloadUrl; a.download = res.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    toast("Export prêt ✓ (" + res.fileName + ")", "success");
  } catch (e) { toast(e.message, "error"); }
}
