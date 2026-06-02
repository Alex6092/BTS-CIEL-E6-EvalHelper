/* ════════════════════════════════════════════════════════════════
   excel.js  —  Génère une COPIE du fichier Excel d'un candidat
                avec les pastilles reportées dans la bonne colonne.

   Édition CHIRURGICALE du .xlsx (zip) : on ne touche QUE le XML de
   l'onglet ciblé (cellules), en préservant les styles. Tout le reste
   (dessins, plages nommées, médias, commentaires, formules) est laissé
   intact octet pour octet — contrairement à une réécriture complète
   qui corrompt dessins et plages nommées.
   ════════════════════════════════════════════════════════════════ */
const JSZip = require("jszip");
const path = require("path");
const fs = require("fs");
const { SHEETS, HIERARCHY, computeLevel } = require("./hierarchy");

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

// Trouve une cellule existante : capture le groupe d'attributs
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
  return insertCell(xml, addr, cell); // fallback si la cellule n'existe pas
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

// Résout le nom d'onglet -> fichier xl/worksheets/sheetN.xml
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

/**
 * @param candidate  ligne candidate (db) — doit avoir excelPath
 * @param sheetKey   'R3' ou 'SO'
 * @param evaluation { itemId: bool } pour ce candidat + onglet
 * @returns { filePath, fileName }
 */
async function exportEvaluation(candidate, sheetKey, evaluation) {
  if (!candidate.excelPath || !fs.existsSync(candidate.excelPath)) {
    throw new Error("Aucun fichier Excel associé à ce candidat.");
  }
  const sheetName = SHEETS[sheetKey];
  if (!sheetName) throw new Error("Onglet inconnu : " + sheetKey);

  const zip = await JSZip.loadAsync(fs.readFileSync(candidate.excelPath));
  const sheetPath = await resolveSheetPath(zip, sheetName);
  let xml = await zip.file(sheetPath).async("string");

  // ── Infos candidat (cellules de valeur fusionnées) ──
  xml = setCellString(xml, "E9",  candidate.nom || "");
  xml = setCellString(xml, "E10", candidate.prenom || "");
  xml = setCellString(xml, "E11", candidate.numero || "");
  xml = setCellString(xml, "E12", new Date().toLocaleDateString("fr-FR"));

  // ── Pastilles -> croix "x" dans la bonne colonne ──
  for (const section of HIERARCHY) {
    for (const item of section.items) {
      const total = (item.children || []).length;
      const checked = (item.children || []).filter(c => evaluation[c.id]).length;
      const { col } = computeLevel(checked, total);
      const row = item.excelRow;
      for (const c of LEVEL_COLS) xml = clearCell(xml, c + row); // exactement une croix
      xml = setCellString(xml, col + row, "x");
    }
  }

  zip.file(sheetPath, xml);

  // ── Forcer le recalcul des formules à l'ouverture ──
  let wb = await zip.file("xl/workbook.xml").async("string");
  if (/<calcPr[^>]*\/>/.test(wb)) {
    wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) =>
      a.includes("fullCalcOnLoad") ? m : `<calcPr${a} fullCalcOnLoad="1"/>`);
  }
  zip.file("xl/workbook.xml", wb);

  // Supprimer les entrées de dossier ajoutées automatiquement par JSZip
  // (inutiles en OOXML, absentes du fichier d'origine)
  for (const k of Object.keys(zip.files)) {
    if (zip.files[k].dir) delete zip.files[k];
  }

  // ── Sauvegarde de la copie (entrées non modifiées préservées) ──
  const buf = await zip.generateAsync({
    type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 },
  });
  const safe = (s) => String(s || "").replace(/[^a-z0-9_-]/gi, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `E6_${safe(candidate.nom)}_${safe(candidate.prenom)}_${sheetKey}_${stamp}.xlsx`;
  const filePath = path.join(EXPORT_DIR, fileName);
  fs.writeFileSync(filePath, buf);

  return { filePath, fileName };
}

module.exports = { exportEvaluation };
