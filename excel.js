/* ════════════════════════════════════════════════════════════════
   excel.js  —  Génère une COPIE du fichier Excel d'un candidat
                avec les évaluations reportées.

   Édition CHIRURGICALE du .xlsx (zip) : on ne modifie QUE le XML des
   onglets remplis, en préservant les styles cellule par cellule.
   Tout le reste (dessins, plages nommées, médias, commentaires Excel,
   formules) est laissé intact octet pour octet.

   - exportEvaluation : remplit UN onglet (selon le rôle de l'appelant)
   - exportFull       : remplit TOUS les onglets (admin / enseignant)
   ════════════════════════════════════════════════════════════════ */
const JSZip = require("jszip");
const path = require("path");
const fs = require("fs");
const { SHEET_CONFIG, SHEET_ORDER, HIERARCHIES, computeLevel } = require("./hierarchy");

const EXPORT_DIR = path.join(__dirname, "exports");
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const LEVEL_COLS = ["C", "D", "E", "F"];

// ── Helpers XML ──
const escXml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const colIndex = (addr) => {
  const c = addr.match(/[A-Z]+/)[0];
  let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};
const rowNum = (addr) => parseInt(addr.match(/\d+/)[0], 10);

function findCellRe(addr) {
  return new RegExp(`<c r="${addr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
}

// Écrit une chaîne (inlineStr) dans une cellule, en préservant le style
function setCellString(xml, addr, value) {
  const v = escXml(value);
  const re = findCellRe(addr);
  const m = xml.match(re);
  const sAttr = m ? ((m[1].match(/ s="\d+"/) || [""])[0]) : "";
  const cell = `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${v}</t></is></c>`;
  if (m) return xml.replace(re, cell);
  return insertCell(xml, addr, cell);
}

// Vide une cellule (garde le style)
function clearCell(xml, addr) {
  const re = findCellRe(addr);
  const m = xml.match(re);
  if (!m) return xml;
  const sAttr = (m[1].match(/ s="\d+"/) || [""])[0];
  return xml.replace(re, `<c r="${addr}"${sAttr}/>`);
}

// Insère une cellule dans sa ligne, au bon emplacement (ordre des colonnes)
function insertCell(xml, addr, cell) {
  const rn = rowNum(addr);
  const rowRe = new RegExp(`(<row r="${rn}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rm = xml.match(rowRe);
  if (!rm) throw new Error(`Ligne ${rn} introuvable pour ${addr}`);
  const target = colIndex(addr);
  const cells = rm[2].match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
  let out = "", inserted = false;
  for (const c of cells) {
    const a = (c.match(/r="([A-Z]+\d+)"/) || [])[1];
    if (!inserted && a && colIndex(a) > target) { out += cell; inserted = true; }
    out += c;
  }
  if (!inserted) out += cell;
  return xml.replace(rowRe, rm[1] + out + rm[3]);
}

// Résout le nom d'onglet -> chemin xl/worksheets/sheetN.xml
async function resolveSheetPath(zip, sheetName) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  const n = escRe(sheetName);
  const sm = wb.match(new RegExp(`<sheet[^>]*name="${n}"[^>]*r:id="(rId\\d+)"`))
          || wb.match(new RegExp(`<sheet[^>]*r:id="(rId\\d+)"[^>]*name="${n}"`));
  if (!sm) throw new Error(`Onglet "${sheetName}" introuvable dans le classeur.`);
  const rid = sm[1];
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const tm = rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))
          || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`));
  if (!tm) throw new Error(`Cible introuvable pour ${rid}.`);
  let target = tm[1].replace(/^\//, "");
  if (!target.startsWith("xl/")) target = "xl/" + target;
  return target;
}

/* Remplit le XML d'un onglet : infos candidat, académie/établissement,
   commentaire, croix des niveaux. */
function fillSheetXml(xml, sheetKey, candidate, evaluation, comment, settings) {
  const cfg = SHEET_CONFIG[sheetKey];

  // En-têtes
  if (settings.academie)      xml = setCellString(xml, cfg.info.academie, settings.academie);
  if (settings.etablissement) xml = setCellString(xml, cfg.info.etablissement, settings.etablissement);
  xml = setCellString(xml, cfg.info.nom, candidate.nom || "");
  xml = setCellString(xml, cfg.info.prenom, candidate.prenom || "");
  xml = setCellString(xml, cfg.info.numero, candidate.numero || "");
  xml = setCellString(xml, cfg.info.date, new Date().toLocaleDateString("fr-FR"));

  // Commentaire (cellule fusionnée, texte multi-lignes accepté)
  if (comment && comment.trim()) {
    xml = setCellString(xml, cfg.commentCell, comment.trim());
  }

  // Croix de niveau — uniquement les lignes de la hiérarchie de CET onglet
  // (en R1, C08/C10 sont absents -> zones "NON EVALUE" fusionnées intactes)
  for (const section of HIERARCHIES[sheetKey]) {
    for (const item of section.items) {
      const total = (item.children || []).length;
      const checked = (item.children || []).filter(c => evaluation[c.id]).length;
      const { col } = computeLevel(checked, total);
      const row = item.excelRow;
      for (const c of LEVEL_COLS) xml = clearCell(xml, c + row);
      xml = setCellString(xml, col + row, "x");
    }
  }
  return xml;
}

/* Force le recalcul des formules à l'ouverture + retire les entrées
   de dossier ajoutées par JSZip. */
async function finalizeZip(zip) {
  let wb = await zip.file("xl/workbook.xml").async("string");
  if (/<calcPr[^>]*\/>/.test(wb)) {
    wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) =>
      a.includes("fullCalcOnLoad") ? m : `<calcPr${a} fullCalcOnLoad="1"/>`);
    zip.file("xl/workbook.xml", wb);
  }
  for (const k of Object.keys(zip.files)) {
    if (zip.files[k].dir) delete zip.files[k];
  }
  return zip.generateAsync({
    type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 },
  });
}

function saveExport(buf, candidate, suffix) {
  const safe = (s) => String(s || "").replace(/[^a-z0-9_-]/gi, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `E6_${safe(candidate.nom)}_${safe(candidate.prenom)}_${suffix}_${stamp}.xlsx`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  return { filePath, fileName };
}

function loadCandidateZip(candidate) {
  if (!candidate.excelPath || !fs.existsSync(candidate.excelPath)) {
    throw new Error("Aucun fichier Excel associé à ce candidat.");
  }
  return JSZip.loadAsync(fs.readFileSync(candidate.excelPath));
}

/**
 * Export d'un seul onglet.
 * @param data { evaluation: {itemId:bool}, comment: string, settings: {academie, etablissement} }
 */
async function exportEvaluation(candidate, sheetKey, data) {
  const cfg = SHEET_CONFIG[sheetKey];
  if (!cfg) throw new Error("Onglet inconnu : " + sheetKey);
  const zip = await loadCandidateZip(candidate);
  const sheetPath = await resolveSheetPath(zip, cfg.name);
  let xml = await zip.file(sheetPath).async("string");
  xml = fillSheetXml(xml, sheetKey, candidate, data.evaluation, data.comment, data.settings);
  zip.file(sheetPath, xml);
  const buf = await finalizeZip(zip);
  return saveExport(buf, candidate, sheetKey);
}

/**
 * Export complet : remplit les 5 onglets avec les données disponibles.
 * @param dataBySheet { [sheetKey]: { evaluation, comment } }, settings à part
 */
async function exportFull(candidate, dataBySheet, settings) {
  const zip = await loadCandidateZip(candidate);
  for (const sheetKey of SHEET_ORDER) {
    const data = dataBySheet[sheetKey] || { evaluation: {}, comment: "" };
    const sheetPath = await resolveSheetPath(zip, SHEET_CONFIG[sheetKey].name);
    let xml = await zip.file(sheetPath).async("string");
    xml = fillSheetXml(xml, sheetKey, candidate, data.evaluation, data.comment, settings);
    zip.file(sheetPath, xml);
  }
  const buf = await finalizeZip(zip);
  return saveExport(buf, candidate, "COMPLET");
}

module.exports = { exportEvaluation, exportFull };
