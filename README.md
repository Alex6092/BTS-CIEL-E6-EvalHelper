# Évaluation E6 – BTS CIEL

Application web de **saisie collaborative** des compétences E6, avec **report automatique** des notes dans les fichiers Excel des candidats.

## Fonctionnalités

- **Liste des candidats** : ajout, suppression, sélection pour la saisie.
- **Association d'un fichier Excel** à un candidat, à tout moment (modifiable).
- **Saisie hiérarchique** des compétences avec pastilles de couleur :
  - 🔴 0 sous-critère coché → **Niveau 1**
  - 🟡 1 sous-critère coché → **Niveau 2**
  - 🔵 2 ou 3 sous-critères cochés → **Niveau 3**
  - 🟢 Tous cochés → **Niveau 4**
- **Critères « Savoir-être »** : regroupent les critères transversaux de chaque compétence.
- **Synchronisation temps réel** (WebSocket) : plusieurs évaluateurs peuvent noter le **même candidat** simultanément.
- **Choix de l'onglet** de report : `E6 REVUES - IR - R3` ou `E6 SOUTENANCE - IR`.
- **Export Excel** : génère une **copie** du fichier du candidat avec les croix (`x`) placées dans la bonne colonne (C/D/E/F) de la bonne ligne. Le fichier d'origine n'est pas modifié. Les formules Excel (totaux, notes) restent intactes et se recalculent à l'ouverture.

## Installation

```bash
npm install
```

## Démarrage

```bash
npm start
```

Le serveur affiche les adresses d'accès :

```
➜  Local   : http://localhost:3000
➜  Réseau  : http://192.168.x.x:3000     ← à donner aux autres évaluateurs (même réseau)
```

Pour changer le port : `PORT=8080 npm start`.

## Utilisation

1. **Ajouter** les candidats (bouton « + Ajouter un candidat »).
2. Pour chaque candidat, **associer son fichier Excel** (« Associer Excel »).
   - Le fichier doit contenir les onglets `E6 REVUES - IR - R3` et/ou `E6 SOUTENANCE - IR`.
3. Cliquer sur **« Noter »** pour ouvrir la grille.
4. Choisir l'**onglet de report** (R3 ou Soutenance) en haut à droite.
5. Cocher les sous-critères : les pastilles et la progression se mettent à jour, et sont **partagées en direct** avec les autres évaluateurs connectés au même candidat + onglet.
6. Cliquer sur **« Exporter Excel »** pour télécharger le fichier rempli.

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur Express + WebSocket + API REST |
| `db.js` | Base de données SQLite (`data/evaluations.db`) |
| `excel.js` | Génération de la copie Excel remplie (édition chirurgicale du zip via JSZip : seul l'onglet ciblé est modifié, dessins/plages nommées/formules intacts) |
| `hierarchy.js` | Données partagées : compétences + mapping lignes/colonnes Excel |
| `public/` | Frontend (HTML / CSS / JS) |
| `uploads/` | Fichiers Excel associés aux candidats |
| `exports/` | Copies générées à télécharger |

## Mapping Excel

Les colonnes de la grille correspondent au nombre d'observables, identique aux pastilles :

| Pastille | Sous-critères cochés | Colonne Excel | Niveau |
|---|---|---|---|
| 🔴 Rouge | 0 | C | Niveau 1 – Non réalisé |
| 🟡 Jaune | 1 | D | Niveau 2 – Réalisation partielle |
| 🔵 Bleu | 2 à 3 | E | Niveau 3 – Réalisation satisfaisante |
| 🟢 Vert | tous (4) | F | Niveau 4 – Réalisation très satisfaisante |

Les infos candidat (Nom, Prénom, Numéro, Date) sont écrites en E9/E10/E11/E12.

> **Note** : `todo.html` est l'ancienne version statique (page unique), conservée pour référence. L'application actuelle se lance via `npm start`.
