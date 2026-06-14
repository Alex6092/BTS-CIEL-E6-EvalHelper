/* ════════════════════════════════════════════════════════════════
   app.js — Client : auth, candidats, saisie collaborative,
   commentaires, administration, exports Excel
   ════════════════════════════════════════════════════════════════ */

/* Pastille / niveau selon le nombre de sous-critères cochés */
function computeLevel(checkedCount, total) {
  if (total === 0 || checkedCount === 0) return { color: "red", level: 1 };
  if (checkedCount === 1 && total > 1)   return { color: "yellow", level: 2 };
  if (checkedCount === total)            return { color: "green", level: 4 };
  return { color: "blue", level: 3 };
}

const ROLE_LABELS = {
  admin: "Administrateur",
  teacher: "Enseignant",
  commission: "Commission",
};

// État global
let me = null;             // { user, allowedSheets }
let HIERARCHIES = {};      // { sheetKey: sections }
let SHEETS = {};           // { sheetKey: {label, name} }
let WEIGHTS = {};          // { sheetKey: { comp: {C01:..}, crit: {itemId:..} } }
let SHEET_LIST = [];       // ordre
let current = { candidate: null, sheet: null };
let state = {};            // { itemId: bool }
let bonus = 0;             // points bonus de l'onglet courant
let noteOverride = "";     // note définitive saisie ("" = aucune)
let canEditCurrent = false;// droit d'écriture sur l'onglet courant
let lockedCurrent = false; // onglet courant verrouillé ?
let canLockCurrent = false;// droit de verrouiller l'onglet courant
let hiddenCurrent = false; // onglet masqué (soutenance non communiquée)
let lockInfo = { lockedAt: null, lockedByName: null };
let ws = null;
let wsReady = false;

/* Note calculée (réplique de la formule F64 du classeur) */
function computeNoteClient(sheetKey, evaluation, bonusVal) {
  const w = WEIGHTS[sheetKey];
  if (!w) return { note: 0, noteProposee: 0 };
  let note = 0;
  for (const section of (HIERARCHIES[sheetKey] || [])) {
    const compW = w.comp[section.id] || 0;
    let totalComp = 0;
    for (const item of section.items) {
      const total = (item.children || []).length;
      const checked = (item.children || []).filter(c => evaluation[c.id]).length;
      const niveau = computeLevel(checked, total).level - 1; // 0..3
      totalComp += (w.crit[item.id] || 0) * niveau;
    }
    note += compW * totalComp;
  }
  note = note * 20 / 3 + (Number(bonusVal) || 0);
  note = Math.round(note * 100) / 100;
  const noteProposee = Math.max(0, Math.ceil(note * 2 - 1e-9) / 2); // évite -0
  return { note, noteProposee };
}

/* ════════════════ Helpers ════════════════ */
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
  if (res.status === 401 && url !== "/api/login") { showLogin(); throw new Error("Session expirée — reconnectez-vous."); }
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  return data;
}

function show(screenId) {
  ["screen-login", "screen-candidates", "screen-grading", "screen-admin"]
    .forEach(id => $("#" + id).classList.toggle("hidden", id !== screenId));
}

const canEdit = () => me && (me.user.role === "admin" || me.user.role === "teacher");
const isAdmin = () => me && me.user.role === "admin";

/* ════════════════ Initialisation ════════════════ */
(async function init() {
  bindUI();
  try {
    me = await api("/api/me");
    await enterApp();
  } catch {
    showLogin();
  }
})();

function showLogin() {
  me = null;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  $("#userbar").classList.add("hidden");
  $("#conn-status").classList.add("hidden");
  show("screen-login");
  setTimeout(() => $("#login-user").focus(), 50);
}

async function enterApp() {
  // Bandeau utilisateur
  $("#userbar").classList.remove("hidden");
  $("#conn-status").classList.remove("hidden");
  $("#ub-name").textContent = me.user.displayName || me.user.username;
  $("#ub-role").textContent = ROLE_LABELS[me.user.role] || me.user.role;
  $("#btn-admin").classList.toggle("hidden", !isAdmin());
  $("#btn-toggle-add").classList.toggle("hidden", !isAdmin()); // candidats gérés par l'admin
  $("#btn-export-full").classList.toggle("hidden", !canEdit());
  $("#btn-export-all").classList.toggle("hidden", !canEdit());

  // Hiérarchies + onglets autorisés
  const h = await api("/api/hierarchy");
  HIERARCHIES = h.hierarchies;
  SHEETS = h.sheets;
  WEIGHTS = h.weights || {};
  SHEET_LIST = h.order;
  const sel = $("#sheet-select");
  sel.innerHTML = "";
  for (const key of SHEET_LIST) {
    const o = el("option"); o.value = key; o.textContent = SHEETS[key].label; sel.appendChild(o);
  }

  connectWS();
  await loadCandidates();
  show("screen-candidates");
}

/* ════════════════ WebSocket ════════════════ */
function connectWS() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    wsReady = true;
    $("#conn-status").textContent = "● En ligne";
    $("#conn-status").classList.add("online");
    if (current.candidate && current.sheet) subscribe();
  };
  ws.onclose = () => {
    wsReady = false;
    $("#conn-status").textContent = "● Hors ligne";
    $("#conn-status").classList.remove("online");
    if (me) setTimeout(connectWS, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      hiddenCurrent = !!msg.hidden;
      lockedCurrent = !!msg.locked;
      canLockCurrent = !!msg.canLock;
      lockInfo = { lockedAt: msg.lockedAt || null, lockedByName: msg.lockedByName || null };
      if (hiddenCurrent) {
        applyEditability();
        return; // pas de données : la soutenance n'est pas communiquée
      }
      state = msg.state || {};
      bonus = Number(msg.bonus) || 0;
      noteOverride = (msg.noteOverride === null || msg.noteOverride === undefined) ? "" : String(msg.noteOverride);
      canEditCurrent = !!msg.canEdit;
      $("#bonus-input").value = bonus;
      $("#note-override-input").value = noteOverride;
      applyEditability();
      renderGridState();
      setCommentValue(msg.comment || "", true);
    } else if (msg.type === "update") {
      state[msg.itemId] = msg.checked;
      applyLeafUpdate(msg.itemId);
    } else if (msg.type === "comment") {
      setCommentValue(msg.text || "", false);
    } else if (msg.type === "bonus") {
      bonus = Number(msg.bonus) || 0;
      if (document.activeElement !== $("#bonus-input")) $("#bonus-input").value = bonus;
      refreshNote();
    } else if (msg.type === "noteOverride") {
      noteOverride = (msg.value === null || msg.value === undefined) ? "" : String(msg.value);
      if (document.activeElement !== $("#note-override-input")) $("#note-override-input").value = noteOverride;
      refreshNote();
    } else if (msg.type === "lockchanged") {
      // Un onglet vient d'être verrouillé : rafraîchir la vue concernée
      if (current.candidate && current.candidate.id === msg.candidateId && current.sheet === msg.sheet) {
        subscribe(); // recharge l'état (lecture seule + soutenance désormais visible)
      }
      if (!$("#screen-candidates").classList.contains("hidden")) loadCandidates();
    } else if (msg.type === "candidates") {
      if (!$("#screen-candidates").classList.contains("hidden")) loadCandidates();
    }
  };
}

function subscribe() {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "subscribe", candidateId: current.candidate.id, sheet: current.sheet }));
}

function sendSet(itemId, checked) {
  if (!wsReady) { toast("Hors ligne — modification non synchronisée", "error"); return; }
  ws.send(JSON.stringify({ type: "set", itemId, checked }));
}

/* ════════════════ Écran login ════════════════ */
async function doLogin(e) {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    me = await api("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
    $("#login-pass").value = "";
    await enterApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
}

/* ════════════════ Écran candidats ════════════════ */
async function loadCandidates() {
  const list = await api("/api/candidates");
  const box = $("#candidate-list");
  box.innerHTML = "";
  // Bouton "Verrouiller le lot" : commission, et au moins une soutenance non verrouillée
  const showBatch = me && me.user.role === "commission" && list.some(c => !c.soLocked);
  $("#batch-lock-bar").classList.toggle("hidden", !showBatch);
  if (!list.length) {
    const e = el("div", "empty-state");
    e.textContent = isAdmin()
      ? "Aucun candidat. Cliquez sur « + Ajouter un candidat »."
      : "Aucun candidat ne vous est associé pour le moment.";
    box.appendChild(e);
    return;
  }
  for (const c of list) box.appendChild(candidateCard(c));
}

function candidateCard(c) {
  const card = el("div", "candidate-card");

  const info = el("div", "info");
  const name = el("div", "name");
  name.textContent = `${c.nom} ${c.prenom}`;
  // Commission : cadenas si la soutenance du candidat est verrouillée
  if (c.soLocked) { const lk = el("span"); lk.textContent = " 🔒"; lk.title = "Soutenance verrouillée"; name.append(lk); }
  const metaParts = [c.numero ? "N° " + c.numero : "—"];
  if (c.className) metaParts.push("🎓 " + c.className);
  const meta = el("div", "meta"); meta.textContent = metaParts.join(" · ");
  info.append(name, meta);
  if (canEdit()) {
    const tag = el("span", "excel-tag " + (c.hasExcel ? "ok" : "no"));
    tag.textContent = c.hasExcel ? "📎 " + (c.excelName || "Excel associé") : "⚠ Aucun fichier Excel";
    info.append(tag);
  }

  // Notes par revue + note finale (établissement uniquement)
  if (c.notes) {
    const fr = (n) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    const locks = c.locks || {};
    const overrides = c.overrides || {};
    const notes = el("div", "notes-row");
    for (const key of SHEET_LIST) {
      if (!(key in c.notes)) continue;
      const chip = el("span", "note-chip");
      const label = SHEETS[key] ? SHEETS[key].label : key;
      if (c.notes[key] === null) {
        // Onglet non communiqué (soutenance non verrouillée)
        chip.classList.add("masked");
        chip.innerHTML = `<span class="nc-label">${label}</span> 🔒`;
        chip.title = "Non communiqué (en attente de verrouillage par la commission)";
      } else {
        const ov = overrides[key] ? " ✍" : "";
        chip.innerHTML = `<span class="nc-label">${label}</span> ${fr(c.notes[key])}${locks[key] ? " 🔒" : ""}${ov}`;
        chip.title = [locks[key] ? "Onglet verrouillé" : "", overrides[key] ? "Note définitive saisie" : ""].filter(Boolean).join(" · ");
      }
      notes.appendChild(chip);
    }
    const fin = el("span", "note-chip finale");
    if (c.notes.finale === null) {
      fin.classList.add("masked");
      fin.innerHTML = `<span class="nc-label">Note finale</span> 🔒`;
      fin.title = "Disponible une fois la soutenance verrouillée";
    } else {
      fin.innerHTML = `<span class="nc-label">Note finale</span> ${fr(c.notes.finale)} / 20${c.finaleLocked ? " 🔒" : ""}`;
    }
    notes.appendChild(fin);
    info.append(notes);
  }

  const actions = el("div", "actions");

  const bGrade = el("button", "btn btn-primary btn-sm"); bGrade.textContent = "Noter";
  bGrade.onclick = () => openGrading(c);
  actions.append(bGrade);

  if (isAdmin()) {
    const bEdit = el("button", "btn btn-outline btn-sm"); bEdit.textContent = "✎ Modifier";
    bEdit.onclick = () => openEditForm(c);
    actions.append(bEdit);

    const bExcel = el("button", "btn btn-outline btn-sm");
    bExcel.textContent = c.hasExcel ? "Changer Excel" : "Associer Excel";
    bExcel.onclick = () => associateExcel(c);
    actions.append(bExcel);

    const bDel = el("button", "btn btn-danger btn-sm"); bDel.textContent = "🗑";
    bDel.title = "Supprimer";
    bDel.onclick = () => deleteCandidate(c);
    actions.append(bDel);
  }

  card.append(info, actions);
  return card;
}

function openEditForm(c) {
  $("#in-edit-id").value = c.id;
  $("#in-nom").value = c.nom;
  $("#in-prenom").value = c.prenom;
  $("#in-numero").value = c.numero || "";
  $("#add-submit").textContent = "Mettre à jour";
  $("#add-form").classList.add("open");
  $("#in-nom").focus();
}

function resetAddForm() {
  $("#in-edit-id").value = "";
  $("#in-nom").value = $("#in-prenom").value = $("#in-numero").value = "";
  $("#add-submit").textContent = "Enregistrer";
  $("#add-form").classList.remove("open");
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
      loadCandidates();
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

/* ════════════════ Liaison UI ════════════════ */
function bindUI() {
  $("#login-form").onsubmit = doLogin;

  $("#btn-logout").onclick = async () => {
    try { await api("/api/logout", { method: "POST" }); } catch {}
    showLogin();
  };

  $("#btn-admin").onclick = () => openAdmin();
  $("#btn-admin-back").onclick = () => { show("screen-candidates"); loadCandidates(); };

  $("#btn-toggle-add").onclick = () => {
    const form = $("#add-form");
    if (form.classList.contains("open")) { resetAddForm(); }
    else { resetAddForm(); form.classList.add("open"); $("#in-nom").focus(); }
  };
  $("#add-cancel").onclick = resetAddForm;

  $("#add-form").onsubmit = async (e) => {
    e.preventDefault();
    const id = $("#in-edit-id").value;
    const body = JSON.stringify({
      nom: $("#in-nom").value.trim(),
      prenom: $("#in-prenom").value.trim(),
      numero: $("#in-numero").value.trim(),
    });
    try {
      if (id) {
        await api(`/api/candidates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
        toast("Candidat mis à jour ✓", "success");
      } else {
        await api("/api/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        toast("Candidat ajouté ✓", "success");
      }
      resetAddForm();
      loadCandidates();
    } catch (err) { toast(err.message, "error"); }
  };

  $("#btn-back").onclick = () => {
    current = { candidate: null, sheet: null };
    show("screen-candidates");
    loadCandidates();
  };

  $("#sheet-select").onchange = () => {
    current.sheet = $("#sheet-select").value;
    buildGrid();
    subscribe();
  };

  $("#btn-export").onclick = () => exportExcel(false);
  $("#btn-export-full").onclick = () => exportExcel(true);
  $("#btn-export-all").onclick = exportAllExcel;
  $("#btn-lock").onclick = lockCurrentSheet;
  $("#btn-lock-batch").onclick = lockBatch;

  // Points bonus : envoi avec debounce
  const bonusInput = $("#bonus-input");
  bonusInput.addEventListener("input", () => {
    if (!canEditCurrent || lockedCurrent) return;
    let v = Math.max(0, Math.min(2, Number(bonusInput.value) || 0));
    bonus = v;
    refreshNote();
    clearTimeout(bonusInput._t);
    bonusInput._t = setTimeout(() => {
      if (!wsReady) { toast("Hors ligne — bonus non synchronisé", "error"); return; }
      ws.send(JSON.stringify({ type: "bonus", bonus: v }));
    }, 400);
  });
  bonusInput.addEventListener("blur", () => { bonusInput.value = bonus; });

  // Note définitive (optionnelle) : envoi avec debounce
  const ovInput = $("#note-override-input");
  ovInput.addEventListener("input", () => {
    if (!canEditCurrent || lockedCurrent) return;
    const raw = ovInput.value.trim();
    // Validation locale : vide, ou nombre dans [0;20]
    if (raw !== "") {
      const n = Number(raw.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > 20) { refreshNote(); return; }
    }
    noteOverride = raw === "" ? "" : raw.replace(",", ".");
    refreshNote();
    clearTimeout(ovInput._t);
    ovInput._t = setTimeout(() => {
      if (!wsReady) { toast("Hors ligne — note non synchronisée", "error"); return; }
      ws.send(JSON.stringify({ type: "noteOverride", value: noteOverride === "" ? null : Number(noteOverride) }));
    }, 500);
  });
  ovInput.addEventListener("blur", () => { ovInput.value = noteOverride; });

  // Commentaire : envoi avec debounce
  const commentInput = $("#comment-input");
  commentInput.addEventListener("input", () => {
    if (!canEditCurrent || lockedCurrent) return;
    $("#comment-status").textContent = "Saisie…";
    clearTimeout(commentInput._t);
    commentInput._t = setTimeout(() => {
      if (!wsReady) { $("#comment-status").textContent = "Hors ligne — non synchronisé"; return; }
      ws.send(JSON.stringify({ type: "comment", text: commentInput.value }));
      $("#comment-status").textContent = "Enregistré ✓";
    }, 600);
  });

  // Formulaires admin
  $("#settings-form").onsubmit = saveSettings;
  $("#user-form").onsubmit = createUser;
  $("#commission-form").onsubmit = createCommission;
  $("#class-form").onsubmit = createClass;
  $("#btn-purge").onclick = doPurge;
}

/* Active / désactive la saisie selon le droit d'écriture, le verrou et le masquage */
function applyEditability() {
  // Onglet masqué (soutenance non communiquée à l'établissement)
  $("#hidden-panel").classList.toggle("hidden", !hiddenCurrent);
  $("#grading-content").classList.toggle("hidden", hiddenCurrent);
  $("#btn-export").classList.toggle("hidden", hiddenCurrent);
  if (hiddenCurrent) {
    $("#readonly-banner").classList.add("hidden");
    $("#locked-banner").classList.add("hidden");
    $("#btn-lock").classList.add("hidden");
    return;
  }

  const editable = canEditCurrent && !lockedCurrent;
  // Bannière "lecture seule" (soutenance non éditable par l'établissement) — pas si verrouillé
  $("#readonly-banner").classList.toggle("hidden", editable || lockedCurrent);

  // Bannière "verrouillé"
  const lb = $("#locked-banner");
  if (lockedCurrent) {
    const d = lockInfo.lockedAt ? new Date(lockInfo.lockedAt).toLocaleString("fr-FR") : "";
    lb.textContent = `🔒 Onglet verrouillé${d ? " le " + d : ""}${lockInfo.lockedByName ? " par " + lockInfo.lockedByName : ""} — modification impossible.`;
    lb.classList.remove("hidden");
  } else {
    lb.classList.add("hidden");
  }

  $("#app").classList.toggle("readonly", !editable);
  $("#comment-input").disabled = !editable;
  $("#bonus-input").disabled = !editable;
  $("#note-override-input").disabled = !editable;

  // Bouton Verrouiller : visible si on peut verrouiller ou si déjà verrouillé (grisé)
  const lockBtn = $("#btn-lock");
  if (lockedCurrent) {
    lockBtn.classList.remove("hidden");
    lockBtn.disabled = true;
    lockBtn.textContent = "🔒 Verrouillé";
  } else if (canLockCurrent) {
    lockBtn.classList.remove("hidden");
    lockBtn.disabled = false;
    lockBtn.textContent = "🔒 Verrouiller";
  } else {
    lockBtn.classList.add("hidden");
  }
}

/* La note définitive saisie est-elle valide (vide accepté = non) ? */
function overrideActive() {
  if (noteOverride === "" || noteOverride === null || noteOverride === undefined) return false;
  const n = Number(noteOverride);
  return Number.isFinite(n) && n >= 0 && n <= 20;
}

/* Met à jour l'affichage : note calculée, note proposée (auto), note retenue */
function refreshNote() {
  const { note, noteProposee } = computeNoteClient(current.sheet, state, bonus);
  const fr = (n, dec) => Number(n).toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  $("#note-calc").textContent = fr(note, 2) + " / 20";
  $("#note-prop").textContent = fr(noteProposee, 1) + " / 20";
  // Note retenue = note définitive si saisie et valide, sinon note proposée
  const retenue = overrideActive() ? Math.round(Number(noteOverride) * 100) / 100 : noteProposee;
  const r = $("#note-retenue");
  r.textContent = fr(retenue, retenue % 1 === 0 ? 0 : 2) + " / 20" + (overrideActive() ? " ✍" : "");
  r.title = overrideActive() ? "Note définitive saisie par l'évaluateur" : "Note proposée automatiquement";
}

/* Mise à jour du commentaire reçue du serveur.
   force=true : état initial (toujours appliquer)
   sinon : ne pas écraser si l'utilisateur est en train de taper */
function setCommentValue(text, force) {
  const input = $("#comment-input");
  if (!force && document.activeElement === input) {
    $("#comment-status").textContent = "✎ Modifié par un autre évaluateur";
    return;
  }
  input.value = text;
  $("#comment-status").textContent = "";
}

/* ════════════════ Écran saisie ════════════════ */
function openGrading(c) {
  current.candidate = c;
  if (!current.sheet || !SHEET_LIST.includes(current.sheet)) current.sheet = SHEET_LIST[0];
  $("#sheet-select").value = current.sheet;
  $("#g-name").textContent = `${c.nom} ${c.prenom}`;
  $("#g-meta").textContent = (c.numero ? "N° " + c.numero + " · " : "") +
    (canEdit() ? (c.hasExcel ? "Excel : " + (c.excelName || "associé") : "⚠ aucun Excel associé") : "");

  // Réinitialiser l'état de verrou/masquage en attendant la réponse du serveur
  hiddenCurrent = false; lockedCurrent = false; canLockCurrent = false;
  lockInfo = { lockedAt: null, lockedByName: null };

  show("screen-grading");
  buildGrid();
  subscribe();
}

function buildGrid() {
  const app = $("#app");
  app.innerHTML = "";
  state = {};
  bonus = 0;
  noteOverride = "";
  $("#bonus-input").value = 0;
  $("#note-override-input").value = "";
  $("#comment-input").value = "";
  $("#comment-status").textContent = "";

  (HIERARCHIES[current.sheet] || []).forEach(section => {
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
        li.onclick = () => {
          if (!canEditCurrent) return;
          ccb.checked = !ccb.checked;
          onChildToggle(item, child, ccb.checked);
        };
        li.append(ccb, span);
        ul.appendChild(li);
      });
      pDiv.appendChild(ul);
      body.appendChild(pDiv);
    });

    card.appendChild(body);
    app.appendChild(card);
  });

  renderGridState();
}

/* ── Toggles ── */
function onParentToggle(item, checked) {
  if (!canEditCurrent) { renderGridState(); return; }
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
  if (!canEditCurrent) { renderGridState(); return; }
  state[child.id] = checked;
  updateChildText(child.id, checked);
  sendSet(child.id, checked);
  refreshParent(item);
  refreshSection(sectionOf(item.id));
  refreshGlobal();
}

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

function renderGridState() {
  (HIERARCHIES[current.sheet] || []).forEach(section => {
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

/* ── Affichage ── */
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
  const section = (HIERARCHIES[current.sheet] || []).find(s => s.id === sectionId);
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
  (HIERARCHIES[current.sheet] || []).forEach(s => s.items.forEach(item => (item.children || []).forEach(c => {
    total++; if (state[c.id]) done++;
  })));
  const pct = total ? Math.round(done / total * 100) : 0;
  $("#global-fill").style.width = pct + "%";
  $("#global-percent").textContent = pct;
  refreshNote();
}

function sectionOf(itemId) {
  for (const s of (HIERARCHIES[current.sheet] || [])) if (s.items.find(i => i.id === itemId)) return s.id;
  return null;
}
function parentOf(childId) {
  for (const s of (HIERARCHIES[current.sheet] || [])) for (const item of s.items)
    if ((item.children || []).find(c => c.id === childId)) return item;
  return null;
}

function expandAll() { document.querySelectorAll(".section-card").forEach(c => c.classList.remove("collapsed")); }
function collapseAll() { document.querySelectorAll(".section-card").forEach(c => c.classList.add("collapsed")); }

/* ════════════════ Verrouillage ════════════════ */
async function lockCurrentSheet() {
  if (!current.candidate || lockedCurrent || !canLockCurrent) return;
  const label = SHEETS[current.sheet] ? SHEETS[current.sheet].label : current.sheet;
  if (!confirm(`Verrouiller l'onglet « ${label} » pour ${current.candidate.nom} ${current.candidate.prenom} ?\n\nLa grille sera figée : plus aucune modification ne sera possible (par personne).`)) return;
  try {
    await api("/api/lock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: current.candidate.id, sheet: current.sheet }),
    });
    toast("Onglet verrouillé ✓", "success");
    subscribe(); // recharge en lecture seule
  } catch (e) { toast(e.message, "error"); }
}

/* Verrouillage du lot (commission) : double confirmation + mot de passe */
async function lockBatch() {
  if (!confirm("Êtes-vous vraiment sûr ?\n\nVous allez verrouiller TOUTES vos soutenances. Vous ne pourrez plus les éditer ensuite.")) return;
  const password = prompt("Confirmez avec le mot de passe de votre compte :");
  if (!password) return;
  try {
    const res = await api("/api/lock-batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    toast(`${res.locked} soutenance(s) verrouillée(s) sur ${res.total} ✓`, "success");
    loadCandidates();
  } catch (e) { toast(e.message, "error"); }
}

/* ════════════════ Exports ════════════════ */
async function exportExcel(full) {
  if (!current.candidate) return;
  try {
    toast("Génération en cours…");
    const res = full
      ? await api("/api/export-full", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: current.candidate.id }),
        })
      : await api("/api/export", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: current.candidate.id, sheet: current.sheet }),
        });
    const a = document.createElement("a");
    a.href = res.downloadUrl; a.download = res.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    toast("Export prêt ✓ (" + res.fileName + ")", "success");
  } catch (e) { toast(e.message, "error"); }
}

/* Export groupé : tous les candidats ayant un Excel, dans un zip */
async function exportAllExcel() {
  if (!confirm("Générer l'export complet de tous les candidats ayant un fichier Excel associé ?")) return;
  try {
    toast("Génération de tous les exports en cours…");
    const res = await api("/api/export-all", { method: "POST" });
    const a = document.createElement("a");
    a.href = res.downloadUrl; a.download = res.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    const skippedMsg = res.skipped ? ` (${res.skipped} candidat(s) sans Excel ignoré(s))` : "";
    toast(`${res.count} fichier(s) exporté(s) ✓${skippedMsg}`, "success");
  } catch (e) { toast(e.message, "error"); }
}

/* ════════════════ Administration ════════════════ */
async function openAdmin() {
  show("screen-admin");
  try {
    const s = await api("/api/settings");
    $("#set-academie").value = s.academie || "";
    $("#set-etablissement").value = s.etablissement || "";
    $("#set-session").value = s.session || "";
    await Promise.all([loadUsers(), loadClasses(), loadCommissions()]);
  } catch (e) { toast(e.message, "error"); }
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    await api("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        academie: $("#set-academie").value.trim(),
        etablissement: $("#set-etablissement").value.trim(),
        session: $("#set-session").value.trim(),
      }),
    });
    toast("Paramètres enregistrés ✓", "success");
  } catch (err) { toast(err.message, "error"); }
}

/* ── Utilisateurs ── */
async function loadUsers() {
  const users = await api("/api/users");
  const box = $("#user-list");
  box.innerHTML = "";
  for (const u of users) {
    const row = el("div", "admin-row");
    const grow = el("div", "grow");
    grow.innerHTML = `<strong>${u.displayName || u.username}</strong>
      <span class="sub">(${u.username})</span>`;
    const role = el("span", "role-tag"); role.textContent = ROLE_LABELS[u.role];

    const bPass = el("button", "btn btn-outline btn-sm"); bPass.textContent = "Mot de passe";
    bPass.onclick = async () => {
      const p = prompt(`Nouveau mot de passe pour ${u.username} :`);
      if (!p) return;
      try {
        await api(`/api/users/${u.id}/password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: p }),
        });
        toast("Mot de passe modifié ✓", "success");
      } catch (e) { toast(e.message, "error"); }
    };

    const bDel = el("button", "btn btn-danger btn-sm"); bDel.textContent = "🗑";
    bDel.onclick = async () => {
      if (!confirm(`Supprimer le compte ${u.username} ?`)) return;
      try {
        await api(`/api/users/${u.id}`, { method: "DELETE" });
        toast("Compte supprimé", "success");
        loadUsers(); loadCommissions();
      } catch (e) { toast(e.message, "error"); }
    };

    row.append(grow, role, bPass, bDel);
    box.appendChild(row);
  }
}

async function createUser(e) {
  e.preventDefault();
  try {
    await api("/api/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#u-username").value.trim(),
        displayName: $("#u-display").value.trim(),
        password: $("#u-password").value,
        role: $("#u-role").value,
      }),
    });
    $("#u-username").value = $("#u-display").value = $("#u-password").value = "";
    toast("Compte créé ✓", "success");
    loadUsers();
  } catch (err) { toast(err.message, "error"); }
}

/* ── Commissions ── */
async function createCommission(e) {
  e.preventDefault();
  try {
    await api("/api/commissions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#comm-name").value.trim() }),
    });
    $("#comm-name").value = "";
    toast("Commission créée ✓", "success");
    loadCommissions();
  } catch (err) { toast(err.message, "error"); }
}

async function loadCommissions() {
  const [commissions, users, candidates] = await Promise.all([
    api("/api/commissions"),
    api("/api/users"),
    api("/api/candidates"),
  ]);
  const commissionUsers = users.filter(u => u.role === "commission");
  const box = $("#commission-list");
  box.innerHTML = "";

  if (!commissions.length) {
    const e = el("div", "empty-state"); e.textContent = "Aucune commission.";
    box.appendChild(e);
    return;
  }

  for (const com of commissions) {
    const row = el("div", "admin-row");
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";

    // ligne titre
    const head = el("div");
    head.style.display = "flex"; head.style.alignItems = "center"; head.style.gap = ".6rem";
    const title = el("strong", "grow"); title.textContent = com.name;
    const bRen = el("button", "btn btn-outline btn-sm"); bRen.textContent = "✎";
    bRen.title = "Renommer";
    bRen.onclick = async () => {
      const n = prompt("Nouveau nom :", com.name);
      if (!n) return;
      await api(`/api/commissions/${com.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      loadCommissions();
    };
    const bDel = el("button", "btn btn-danger btn-sm"); bDel.textContent = "🗑";
    bDel.onclick = async () => {
      if (!confirm(`Supprimer la commission « ${com.name} » ?`)) return;
      await api(`/api/commissions/${com.id}`, { method: "DELETE" });
      loadCommissions();
    };
    head.append(title, bRen, bDel);
    row.appendChild(head);

    // membres
    row.appendChild(chipList("Membres (jury) :", com.members,
      (m) => m.displayName || m.username,
      async (m) => { await api(`/api/commissions/${com.id}/members/${m.id}`, { method: "DELETE" }); loadCommissions(); },
      commissionUsers.filter(u => !com.members.some(m => m.id === u.id)),
      (u) => u.displayName || u.username,
      async (uId) => {
        await api(`/api/commissions/${com.id}/members`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uId }),
        });
        loadCommissions();
      }));

    // candidats
    row.appendChild(chipList("Candidats :", com.candidates,
      (c) => `${c.nom} ${c.prenom}`,
      async (c) => { await api(`/api/commissions/${com.id}/candidates/${c.id}`, { method: "DELETE" }); loadCommissions(); },
      candidates.filter(c => !com.candidates.some(x => x.id === c.id)),
      (c) => `${c.nom} ${c.prenom}`,
      async (cId) => {
        await api(`/api/commissions/${com.id}/candidates`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: cId }),
        });
        loadCommissions();
      }));

    box.appendChild(row);
  }
}

/* ── Classes ── */
async function createClass(e) {
  e.preventDefault();
  try {
    await api("/api/classes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#class-name").value.trim() }),
    });
    $("#class-name").value = "";
    toast("Classe créée ✓", "success");
    loadClasses();
  } catch (err) { toast(err.message, "error"); }
}

async function loadClasses() {
  const [classes, users, candidates] = await Promise.all([
    api("/api/classes"),
    api("/api/users"),
    api("/api/candidates"),
  ]);
  const teacherUsers = users.filter(u => u.role === "teacher");
  const box = $("#class-list");
  box.innerHTML = "";

  if (!classes.length) {
    const e = el("div", "empty-state"); e.textContent = "Aucune classe.";
    box.appendChild(e);
    return;
  }

  for (const cls of classes) {
    const row = el("div", "admin-row");
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";

    const head = el("div");
    head.style.display = "flex"; head.style.alignItems = "center"; head.style.gap = ".6rem";
    const title = el("strong", "grow"); title.textContent = cls.name;
    const bRen = el("button", "btn btn-outline btn-sm"); bRen.textContent = "✎"; bRen.title = "Renommer";
    bRen.onclick = async () => {
      const n = prompt("Nouveau nom :", cls.name);
      if (!n) return;
      try {
        await api(`/api/classes/${cls.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n }),
        });
        loadClasses();
      } catch (e) { toast(e.message, "error"); }
    };
    const bDel = el("button", "btn btn-danger btn-sm"); bDel.textContent = "🗑";
    bDel.onclick = async () => {
      if (!confirm(`Supprimer la classe « ${cls.name} » ? Les candidats ne seront pas supprimés mais détachés de la classe.`)) return;
      try {
        await api(`/api/classes/${cls.id}`, { method: "DELETE" });
        loadClasses();
      } catch (e) { toast(e.message, "error"); }
    };
    head.append(title, bRen, bDel);
    row.appendChild(head);

    // Enseignants
    row.appendChild(chipList("Enseignants :", cls.teachers,
      (m) => m.displayName || m.username,
      async (m) => { await api(`/api/classes/${cls.id}/teachers/${m.id}`, { method: "DELETE" }); loadClasses(); },
      teacherUsers.filter(u => !cls.teachers.some(m => m.id === u.id)),
      (u) => u.displayName || u.username,
      async (uId) => {
        await api(`/api/classes/${cls.id}/teachers`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uId }),
        });
        loadClasses();
      }));

    // Candidats (un candidat = une seule classe ; en rattacher un le déplace)
    row.appendChild(chipList("Candidats :", cls.candidates,
      (c) => `${c.nom} ${c.prenom}`,
      async (c) => { await api(`/api/classes/${cls.id}/candidates/${c.id}`, { method: "DELETE" }); loadClasses(); },
      candidates.filter(c => c.classId !== cls.id),
      (c) => `${c.nom} ${c.prenom}` + (c.className ? ` (actuellement : ${c.className})` : ""),
      async (cId) => {
        await api(`/api/classes/${cls.id}/candidates`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: cId }),
        });
        loadClasses();
      }));

    box.appendChild(row);
  }
}

/* ── Purge annuelle ── */
async function doPurge() {
  if (!confirm("ARCHIVER puis SUPPRIMER tous les candidats et leurs évaluations ?\n\nUne copie de sauvegarde de la base sera créée. Les comptes, classes et commissions seront conservés.\n\nCette action est irréversible.")) return;
  if (!confirm("Dernière confirmation : supprimer définitivement tous les candidats ?")) return;
  try {
    const r = await api("/api/purge", { method: "POST" });
    toast(`Purge effectuée : ${r.removed} candidat(s) supprimé(s). Archive : ${r.archived}`, "success");
    loadClasses(); loadCommissions();
  } catch (e) { toast(e.message, "error"); }
}

/* Construit une ligne "label + chips + select d'ajout" */
function chipList(label, items, getLabel, onRemove, available, getAvailLabel, onAdd) {
  const wrap = el("div", "assign-row");
  const lab = el("span", "sub"); lab.textContent = label;
  wrap.appendChild(lab);

  const chips = el("div", "chips");
  for (const item of items) {
    const chip = el("span", "chip");
    const txt = document.createTextNode(getLabel(item));
    const x = el("button"); x.textContent = "×"; x.title = "Retirer";
    x.onclick = () => onRemove(item).catch(e => toast(e.message, "error"));
    chip.append(txt, x);
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);

  if (available.length) {
    const sel = el("select");
    const def = el("option"); def.value = ""; def.textContent = "+ Ajouter…";
    sel.appendChild(def);
    for (const a of available) {
      const o = el("option"); o.value = a.id; o.textContent = getAvailLabel(a);
      sel.appendChild(o);
    }
    sel.onchange = () => { if (sel.value) onAdd(Number(sel.value)).catch(e => toast(e.message, "error")); };
    wrap.appendChild(sel);
  }
  return wrap;
}
