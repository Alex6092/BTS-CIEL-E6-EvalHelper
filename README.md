# Évaluation E6 – BTS CIEL

Application web de **saisie collaborative** des évaluations de l'épreuve E6 (stage, revues de projet, soutenance), avec **comptes utilisateurs**, **commissions** et **report automatique** dans les fichiers Excel des candidats.

## Démarrage

```bash
npm install
npm start
```

Le serveur affiche les adresses d'accès :

```
➜  Local   : http://localhost:3000
➜  Réseau  : http://192.168.x.x:3000     ← à donner aux autres évaluateurs (même réseau)
```

Au **premier lancement**, un compte administrateur est créé : **admin / admin** (affiché dans la console). Changez ce mot de passe depuis le panneau d'administration.

Pour changer le port : `PORT=8080 npm start`.

## Rôles et droits

| | Membre de commission | Enseignant établissement | Administrateur |
|---|---|---|---|
| Candidats visibles | Ceux de ses commissions | Tous | Tous |
| Onglets accessibles | Soutenance uniquement | Les 5 | Les 5 |
| **Saisie Soutenance** | **✓ (exclusif)** | lecture seule | lecture seule |
| Saisie Stage / Revues | — | ✓ | ✓ |
| Créer / modifier candidats | — | ✓ | ✓ |
| Associer un Excel | — | ✓ | ✓ |
| Export d'un onglet | Soutenance | ✓ | ✓ |
| Export complet (5 onglets) | — | ✓ | ✓ |
| **Export groupé (tous les candidats, zip)** | — | ✓ | ✓ |
| Comptes, commissions, paramètres | — | — | ✓ |

**Pourquoi ?** La soutenance est menée par un jury externe (la commission) qui ne doit pas être influencé par les notes des autres oraux : il ne voit que la saisie soutenance. Inversement, l'onglet Soutenance n'est **modifiable que par la commission** — l'établissement le voit en lecture seule, pour éviter toute altération de l'évaluation du jury. L'établissement trace tous les oraux et génère l'Excel final complet — c'est l'Excel qui calcule la note.

## Les 5 onglets

| Onglet | Grille | Particularités |
|---|---|---|
| Stage | `E6 STAGE - IR` | Lignes décalées, observables spécifiques au stage, C08 à 3 critères |
| Revue 1 | `E6 REVUES - IR - R1` | **C08 et C10 non évalués** (zones « NON EVALUE » du template préservées) |
| Revue 2 | `E6 REVUES - IR - R2` | Grille standard |
| Revue 3 | `E6 REVUES - IR - R3` | Grille standard |
| Soutenance | `E6 SOUTENANCE - IR` | Grille standard — seul onglet visible des commissions |

Les **observables** (sous-critères) de chaque grille ont été extraits des commentaires de cellules du template Excel. Les critères transversaux sont regroupés sous **« Savoir-être »** (une ligne Excel par compétence).

## Saisie

- Pastilles : 🔴 0 coché → Niveau 1 (col. C) · 🟡 1 → Niveau 2 (D) · 🔵 2+ → Niveau 3 (E) · 🟢 tous → Niveau 4 (F)
- **Synchronisation temps réel** (WebSocket) entre tous les évaluateurs sur le même candidat + onglet
- **Commentaire par onglet**, synchronisé lui aussi, reporté dans la case commentaire de l'Excel
- **Points bonus** (/2) par onglet, reportés en C63
- **Note calculée** affichée en direct — réplique exacte de la formule du classeur :
  `note = Σ(poids_compétence × Σ(poids_critère × niveau 0-3)) × 20/3 + bonus`
- **Note proposée au jury** = arrondi au demi-point supérieur, écrite en C64 à l'export

## Export Excel

- **Exporter cet onglet** : remplit l'onglet courant (croix, commentaire, bonus, note proposée, nom/prénom/numéro/date, académie/établissement)
- **Exporter tout** (enseignant/admin) : remplit les 5 onglets d'un coup — l'Excel calcule la note finale
- **Exporter tous les Excel** (écran candidats, enseignant/admin) : un zip contenant l'export complet de chaque candidat ayant un fichier Excel associé
- L'export est une **copie** : le fichier associé au candidat n'est jamais modifié
- Édition chirurgicale du zip (JSZip) : dessins, plages nommées, formules et fusions restent intacts ; les formules se recalculent à l'ouverture

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Express + WebSocket + API REST + contrôle d'accès |
| `auth.js` | Mots de passe (scrypt), sessions cookie, rôles |
| `db.js` | SQLite (`data/evaluations.db`) : candidats, évaluations, commentaires, comptes, commissions, paramètres |
| `excel.js` | Génération des copies Excel remplies |
| `hierarchy.js` | Grilles des 5 onglets + mapping lignes/colonnes Excel |
| `public/` | Frontend (login, candidats, saisie, administration) |
| `uploads/` | Fichiers Excel associés aux candidats |
| `exports/` | Copies générées à télécharger |

> **Note** : `todo.html` est l'ancienne version statique, conservée pour référence.
