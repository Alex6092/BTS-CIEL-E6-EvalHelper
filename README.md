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
| Candidats visibles | Ceux de ses commissions | Ceux de ses **classes** | Tous |
| Onglets accessibles | Soutenance uniquement | Les 5 | Les 5 |
| **Saisie Soutenance** | **✓ (exclusif)** | lecture seule | lecture seule |
| Saisie Stage / Revues | — | ✓ (ses classes) | ✓ |
| Créer / modifier / supprimer candidats | — | — | ✓ |
| Associer un Excel | — | — | ✓ |
| Export d'un onglet | Soutenance | ✓ (ses classes) | ✓ |
| Export complet (5 onglets) | — | ✓ (ses classes) | ✓ |
| **Export groupé (zip)** | — | ✓ (ses classes) | ✓ (tous) |
| Comptes, classes, commissions, paramètres, purge | — | — | ✓ |

**Pourquoi ?** La soutenance est menée par un jury externe (la commission) qui ne doit pas être influencé par les notes des autres oraux : il ne voit que la saisie soutenance. Inversement, l'onglet Soutenance n'est **modifiable que par la commission** — l'établissement le voit en lecture seule, pour éviter toute altération de l'évaluation du jury. L'établissement trace tous les oraux et génère l'Excel final complet — c'est l'Excel qui calcule la note.

## Classes et commissions

Deux regroupements distincts, configurés par l'**administrateur** :

- **Classe** (groupe pédagogique, ex. CIEL scolaire / apprentissage) : rassemble des **enseignants** et des **candidats**. Un enseignant ne peut consulter et noter (stage + revues) que les candidats de **ses** classes. Un candidat appartient à **une seule** classe.
- **Commission** (jury externe de soutenance) : rassemble des **membres de commission** et les **candidats** qu'ils évaluent en soutenance.

La création/modification des candidats et tous les rattachements sont réservés à l'administrateur.

## Verrouillage des onglets

Une fois une revue passée, on **verrouille** son onglet pour figer l'évaluation :

- Bouton **« Verrouiller »** sur la page d'évaluation (confirmation requise ; grisé une fois verrouillé).
- Un onglet verrouillé devient **lecture seule pour tout le monde, y compris l'administrateur** — l'API et le WebSocket refusent toute modification (vérifié côté serveur, pas seulement masqué dans l'interface).
- La **date de verrouillage** est enregistrée et reportée dans le champ « Date » de l'onglet Excel correspondant.
- Qui peut verrouiller : la soutenance → **membre de commission uniquement** ; les autres onglets → établissement (enseignant de la classe / admin).

### Soutenance : confidentialité jusqu'au verrouillage

Tant que la commission n'a **pas verrouillé** la soutenance d'un candidat, l'établissement (enseignants et admin) **ne peut pas voir** cette évaluation :
- masquée dans l'interface (message d'attente) et **non synchronisée** par WebSocket (aucune fuite en direct) ;
- **note de soutenance et note finale masquées** dans la liste des candidats ;
- **exclue des exports Excel** de l'établissement (onglet laissé vierge, note finale non écrite) — pour qu'on ne puisse pas la lire en ouvrant le fichier.

Dès que la commission verrouille, tout devient visible (avec un cadenas).

### Cadenas dans la liste

- Établissement : un 🔒 s'affiche à côté de chaque note d'onglet verrouillé ; la note de soutenance/finale apparaît verrouillée une fois communiquée.
- Commission : un 🔒 s'affiche sur chaque candidat dont la soutenance est verrouillée.

### Verrouiller le lot (commission)

Bouton **« Verrouiller le lot »** : verrouille la soutenance de **tous** les candidats attribués, en une fois. Double confirmation : message d'avertissement, puis **saisie du mot de passe** du compte pour valider.

## Purge de début d'année

Bouton dédié dans le panneau d'administration : il **archive** d'abord la base (copie `data/archive-<date>.db`), puis **supprime tous les candidats** et leurs évaluations/fichiers. Les comptes, classes, commissions et paramètres sont conservés. Double confirmation requise.

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

- **Exporter cet onglet** : remplit l'onglet courant (croix, commentaire, bonus, note proposée, nom/prénom/numéro/date, académie/établissement, session)
- **Exporter tout** (enseignant/admin) : remplit les 5 onglets + la **fiche récapitulative** (infos candidat, session, et **note finale** en C34)
- **Exporter tous les Excel** (écran candidats, enseignant/admin) : un zip contenant l'export complet de chaque candidat ayant un fichier Excel associé
- L'export est une **copie** : le fichier associé au candidat n'est jamais modifié
- Édition chirurgicale du zip (JSZip) : dessins, plages nommées, formules et fusions restent intacts ; les formules se recalculent à l'ouverture

## Note finale

`note finale = (Stage×1 + Revue 3×3 + Soutenance×3) / 7` à partir des notes proposées (C64)
de chaque onglet, arrondie au **demi-point supérieur** et reportée en C34 de la fiche
récapitulative (la formule F34 du classeur fait le même calcul). Les notes par revue et
la note finale sont affichées dans la liste des candidats (établissement uniquement).

## Divers

- À la création d'un candidat, le fichier `E6 - Template.xlsx` lui est associé par défaut (modifiable ensuite).
- L'**année de session** (panneau admin) est reportée dans tous les onglets (`SESSION 20xx`).

## Sécurité

- Mots de passe : **scrypt** avec sel aléatoire de 16 octets par compte (fonction à dérivation
  coûteuse en mémoire, conçue pour le stockage de mots de passe — plus robuste que SHA-512+sel
  face aux attaques par GPU), comparaison à temps constant.
- Sessions : jeton aléatoire 256 bits en cookie **HttpOnly** (SameSite=Lax), expiration 7 jours.
- **Toutes** les routes API et le WebSocket exigent une session valide ; chaque action est
  contrôlée selon le rôle **côté serveur** (un client trafiqué ne peut ni écrire la soutenance
  en tant qu'admin/enseignant, ni accéder aux candidats/onglets hors périmètre commission).
- SQL : exclusivement des **requêtes préparées** avec paramètres liés (pas d'injection possible).
- Entrées validées partout (types, bornes, tailles) ; JSON malformé, ids invalides, payloads
  WS corrompus → réponse 4xx propre sans stack trace, le serveur ne tombe pas.
- Téléchargements : seul l'utilisateur qui a généré un export peut le télécharger ;
  traversée de chemin neutralisée ; upload limité à 25 Mo, `.xlsx` uniquement.

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Express + WebSocket + API REST + contrôle d'accès |
| `auth.js` | Mots de passe (scrypt), sessions cookie, rôles |
| `db.js` | SQLite (`data/evaluations.db`) : candidats, évaluations, commentaires, **verrous**, comptes, classes, commissions, paramètres ; archive/purge. Chemin surchargeable via `DB_FILE`. |
| `excel.js` | Génération des copies Excel remplies |
| `hierarchy.js` | Grilles des 5 onglets + mapping lignes/colonnes Excel |
| `public/` | Frontend (login, candidats, saisie, administration) |
| `uploads/` | Fichiers Excel associés aux candidats |
| `exports/` | Copies générées à télécharger |

> **Note** : `todo.html` est l'ancienne version statique, conservée pour référence.
