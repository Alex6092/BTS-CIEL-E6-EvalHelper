# Évaluation E6 – BTS CIEL

Application web de **saisie collaborative** des évaluations de l'épreuve E6 (stage, revues de projet, soutenance), avec **comptes utilisateurs**, **commissions** et **report automatique** dans les fichiers Excel des candidats.

## Démarrage

```bash
npm install
npm start
```

Tests automatiques (inscription, mots de passe, sécurité : chaque attaque relevée lors de l'audit est rejouée) : `npm test`.
Ils démarrent le serveur sur une base temporaire et ne touchent pas à `data/evaluations.db`.

### Prérequis sur Linux (Debian / Ubuntu)

`better-sqlite3` est un module natif. Si aucun binaire précompilé n'est disponible pour la
plateforme, `npm install` le compile localement, ce qui nécessite les outils de compilation.
Sans eux, l'installation échoue avec `gyp ERR! ... not found: make`.

```bash
sudo apt update && sudo apt install -y build-essential python3
rm -rf node_modules && npm install
```

- Node.js **22 LTS** recommandé (20.x fonctionne encore mais n'est plus maintenu).
- Ne jamais copier `node_modules` depuis une autre machine ou un autre OS : toujours
  lancer `npm install` sur la machine cible.

## Déploiement (serveur Linux)

Configuration recommandée : l'application tourne sur le port 3000 sous le compte `debian`,
**n'écoute que sur la machine elle-même** (`HOST=127.0.0.1`), et **nginx** la publie en
**HTTPS**. Sans HTTPS, les mots de passe, les cookies de session et les notes circulent
**en clair** sur le réseau (Wi-Fi compris) : n'importe qui à l'écoute peut les lire et se
connecter à la place d'un utilisateur, y compris de l'administrateur.

> Sous Linux, un compte non-root ne peut pas écouter sur un port inférieur à 1024 :
> `PORT=80 npm start` échoue avec « Permission refusée ». C'est nginx qui écoute sur 80/443.

### 1. Service systemd (démarrage automatique, redémarrage en cas de crash)

`/etc/systemd/system/evale6.service` :

```ini
[Unit]
Description=Evaluation E6 BTS CIEL
After=network.target

[Service]
Type=simple
User=debian
WorkingDirectory=/home/debian/EvalE6/BTS-CIEL-E6-EvalHelper
Environment=PORT=3000
# Écoute uniquement en local : seul nginx (donc HTTPS) peut joindre l'application
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=always
# Fichiers créés (base, exports, archives) lisibles par le seul compte debian
UMask=0077
# Durcissement : pas d'élévation de privilèges, /usr /boot /etc en lecture seule,
# /tmp privé
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now evale6
journalctl -u evale6 -f        # logs (dont le mot de passe admin initial)
```

L'application applique d'elle-même ces droits restreints (dossiers `data/`, `uploads/`,
`exports/` en 700, fichiers en 600) à chaque démarrage ; `UMask=0077` est une sécurité de plus.

### 2. nginx en HTTPS

```bash
sudo apt install -y nginx
```

Il faut un **certificat** pour le nom du serveur :
- **serveur joignable depuis Internet avec un nom de domaine** : certificat gratuit
  Let's Encrypt (`sudo apt install -y certbot python3-certbot-nginx` puis
  `sudo certbot --nginx -d eval-e6.mon-lycee.fr`, renouvellement automatique) ;
- **serveur interne** : certificat fourni par le service informatique de l'établissement
  ou de l'académie (à défaut un certificat auto-signé, mais chaque navigateur affichera
  un avertissement à accepter une fois).

`/etc/nginx/sites-available/evale6` (remplacer `eval-e6.mon-lycee.fr` et les chemins du certificat) :

```nginx
# HTTP -> HTTPS
server {
    listen 80;
    server_name eval-e6.mon-lycee.fr;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name eval-e6.mon-lycee.fr;

    ssl_certificate     /etc/letsencrypt/live/eval-e6.mon-lycee.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eval-e6.mon-lycee.fr/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 30m;               # upload des fichiers Excel (25 Mo max côté appli)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # indispensable pour le WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;  # adresse réelle du client (limitation des tentatives)
        proxy_set_header X-Forwarded-Proto $scheme;     # HTTPS : cookie « Secure » + HSTS
        proxy_read_timeout 1h;                   # évite la coupure du WebSocket inactif
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/evale6 /etc/nginx/sites-enabled/evale6
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

À quoi servent les en-têtes :
- `Upgrade` / `Connection` : sans eux, les pages s'affichent mais la synchronisation temps
  réel ne passe pas (badge « Hors ligne ») ;
- `X-Forwarded-For` : sans lui, l'application voit toutes les connexions comme venant de
  nginx et la limitation des tentatives s'applique à tout le monde à la fois ;
- `X-Forwarded-Proto` : indique à l'application qu'elle est servie en HTTPS (cookie de
  session `Secure`, en-tête HSTS).

Ces en-têtes ne sont acceptés que s'ils viennent de la machine elle-même : un client ne peut
pas les falsifier.

**Port non standard** (ex. `https://serveur:8443`) : utiliser `proxy_set_header Host $http_host;`
(qui garde le port), ou définir `Environment=PUBLIC_ORIGIN=https://serveur:8443` dans le service.
Sinon les navigateurs anciens (sans en-tête `Sec-Fetch-Site`) seraient refusés par la
protection contre les requêtes venant d'un autre site.

### 3. Pare-feu

N'ouvrir que SSH, HTTP (redirection) et HTTPS. Avec `HOST=127.0.0.1`, le port 3000 n'est de
toute façon pas joignable depuis le réseau.

```bash
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 et 443
sudo ufw enable
```

### Alternative rapide (sans nginx, réseau local uniquement)

Pour un essai sur un réseau de confiance : `npm start`, puis donner l'adresse affichée
(`http://192.168.x.x:3000`) aux évaluateurs. **Tout circule alors en clair** : à réserver aux
tests, jamais pour une session d'examen réelle ni sur un réseau Wi-Fi partagé.

### Premier lancement

Un compte **`admin`** est créé avec un **mot de passe aléatoire**, affiché **une seule fois**
dans la console (`journalctl -u evale6` avec systemd). On peut aussi le fixer avec la variable
`ADMIN_INITIAL_PASSWORD`. Ce mot de passe est **provisoire** : à la première connexion,
l'application exige de le remplacer avant de donner accès à quoi que ce soit.

Installation existante dont le compte `admin` a encore le mot de passe `admin` : il est
détecté au démarrage et devra être changé à la prochaine connexion.

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute | `3000` |
| `HOST` | Adresse d'écoute (`127.0.0.1` derrière nginx) | toutes les interfaces |
| `DB_FILE` | Chemin de la base SQLite | `data/evaluations.db` |
| `ADMIN_INITIAL_PASSWORD` | Mot de passe provisoire du compte `admin` créé au premier lancement | aléatoire |
| `PUBLIC_ORIGIN` | Adresse(s) publique(s) du site, séparées par des virgules, si le proxy modifie l'en-tête `Host` | — |

### Données personnelles : conservation

- **Exports Excel** : supprimés du serveur dès leur téléchargement, au plus tard au bout d'une
  heure s'ils ne sont jamais téléchargés, et à la purge.
- **Archives de purge** (`data/archive-<date>.db`) : copie complète de l'année (candidats, notes,
  comptes), sans les sessions. Elles ne sont jamais supprimées automatiquement : les supprimer
  quand la durée de conservation fixée par l'établissement est écoulée.
- **Sauvegarde** : copier `data/` (la base) et `uploads/` (fichiers Excel des candidats), en
  conservant des droits restreints sur la copie.

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
| Créer son compte (si les inscriptions sont ouvertes) | ✓ | — | — |
| Changer son propre mot de passe (« Mon compte ») | ✓ | ✓ | ✓ |
| Comptes, classes, commissions, paramètres, purge | — | — | ✓ |
| Ouvrir / fermer les inscriptions | — | — | ✓ |

**Pourquoi ?** La soutenance est menée par un jury externe (la commission) qui ne doit pas être influencé par les notes des autres oraux : il ne voit que la saisie soutenance. Inversement, l'onglet Soutenance n'est **modifiable que par la commission** — l'établissement le voit en lecture seule, pour éviter toute altération de l'évaluation du jury. L'établissement trace tous les oraux et génère l'Excel final complet — c'est l'Excel qui calcule la note.

## Classes et commissions

Deux regroupements distincts, configurés par l'**administrateur** :

- **Classe** (groupe pédagogique, ex. CIEL scolaire / apprentissage) : rassemble des **enseignants** et des **candidats**. Un enseignant ne peut consulter et noter (stage + revues) que les candidats de **ses** classes. Un candidat appartient à **une seule** classe.
- **Commission** (jury externe de soutenance) : rassemble des **membres de commission** et les **candidats** qu'ils évaluent en soutenance.

La création/modification des candidats et tous les rattachements sont réservés à l'administrateur.

## Comptes et inscriptions

Pour que l'administrateur n'ait pas à connaître les mots de passe des jurés, les membres de
commission peuvent **créer leur compte eux-mêmes** :

1. Dans **Administration → Inscriptions des membres de commission**, l'admin clique sur
   **« Ouvrir les inscriptions »** et communique l'adresse de l'application aux jurés.
2. L'écran de connexion affiche alors un lien **« Créer un compte »** : le juré choisit son
   identifiant (3 à 50 caractères : lettres sans accent, chiffres, `.` `_` `-`), indique ses
   nom et prénom et son mot de passe (8 caractères minimum). Il est connecté directement.
3. Le compte a **toujours** le rôle « Membre de commission » (le serveur ignore tout autre rôle)
   et **ne voit aucun candidat** tant que l'admin ne l'a pas associé à une commission.
   Dans la liste des comptes, il porte les badges **« Auto-inscrit »** et **« ⏳ Sans commission »** ;
   un compteur signale les comptes en attente d'affectation.
4. L'admin vérifie l'identité du juré, l'associe à sa commission (section « Commissions »),
   puis **ferme les inscriptions**. Un compte inconnu ou en double se supprime simplement.

L'admin peut toujours créer lui-même des comptes (enseignants, administrateurs, ou jurés) avec un
**mot de passe provisoire** (champ masqué). À sa **première connexion**, l'utilisateur doit le
remplacer par le sien avant d'accéder à quoi que ce soit : l'admin ne connaît donc jamais le mot
de passe définitif. Ensuite, chacun peut changer son mot de passe quand il veut depuis
**« Mon compte »** (le mot de passe actuel est demandé).

- Changer son mot de passe **déconnecte ses autres sessions** (autres navigateurs ou appareils).
- En cas d'oubli, l'admin **réinitialise** le mot de passe (bouton « Mot de passe ») avec un
  nouveau mot de passe provisoire, à remplacer à la connexion suivante : toutes les sessions du
  compte sont fermées.

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

Bouton dédié dans le panneau d'administration : il **archive** d'abord la base (copie `data/archive-<date>.db`, sans les sessions), puis **supprime tous les candidats** et leurs évaluations/fichiers, ainsi que les exports en attente de téléchargement. Les comptes, classes, commissions et paramètres sont conservés. Confirmation, puis **mot de passe de l'admin** exigé.

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
- La copie n'est téléchargeable **qu'une fois**, par celui qui l'a générée : elle est supprimée
  du serveur après le téléchargement (ou au bout d'une heure). Pour la récupérer à nouveau,
  relancer l'export.
- Édition chirurgicale du zip (JSZip) : dessins, plages nommées, formules et fusions restent intacts ; les formules se recalculent à l'ouverture

## Note finale

`note finale = (Stage×1 + Revue 3×3 + Soutenance×3) / 7` à partir des notes retenues (C64)
de chaque onglet, arrondie au **demi-point supérieur** et reportée en C34 de la fiche
récapitulative (la formule F34 du classeur fait le même calcul). Les notes par revue et
la note finale sont affichées dans la liste des candidats (établissement uniquement).

### Note définitive (optionnelle)

Sur chaque onglet, l'évaluateur peut saisir une **note définitive** s'il estime que la note
proposée (arrondi ½ pt sup.) ne convient pas (ex. 12,07 → 12,5 alors qu'il veut 12).
- Champ optionnel : laissé vide → la note proposée automatique s'applique.
- Si renseignée (0–20), c'est elle qui est **retenue** partout : affichage, cellule `C64` de
  l'onglet, et **note finale** du récapitulatif (cohérent avec le calcul interne d'Excel).
- Le calcul de la « note retenue » est centralisé dans une seule fonction
  (`proposedNote` dans `hierarchy.js`), utilisée par la liste des candidats et tous les exports,
  pour garantir l'unicité du résultat. Soumise aux mêmes règles que le reste (verrou, confidentialité soutenance).

## Divers

- À la création d'un candidat, le fichier `E6 - Template.xlsx` lui est associé par défaut (modifiable ensuite).
- L'**année de session** (panneau admin) est reportée dans tous les onglets (`SESSION 20xx`).

## Sécurité

**Comptes et mots de passe**
- Mots de passe : **scrypt** avec sel aléatoire de 16 octets par compte (fonction à dérivation
  coûteuse en mémoire, conçue pour le stockage de mots de passe), calcul asynchrone (le serveur
  reste disponible), comparaison à temps constant ; 8 caractères minimum pour tout nouveau mot
  de passe.
- Jamais affichés en clair dans l'interface (champs masqués partout).
- Mot de passe **provisoire** (compte créé ou réinitialisé par l'admin, compte `admin` initial
  aléatoire) : à remplacer à la première connexion, tout le reste est refusé avant.
- Inscription publique : fermée par défaut, ouverte/fermée par l'admin, rôle imposé
  « commission », aucun accès aux candidats avant affectation par l'admin.
- **Limitation des tentatives** (en mémoire ; adresses IPv6 regroupées par bloc /64) :
  - connexion bloquée 15 min après 10 échecs pour un même identifiant depuis une même
    adresse, ou 50 échecs depuis une même adresse ;
  - au-delà de 10 échecs sur un compte, **toutes adresses confondues**, chaque nouvel essai
    doit attendre de plus en plus longtemps (jusqu'à 5 min) : une attaque répartie sur de
    nombreuses machines reste très lente ;
  - inscription : 30 tentatives par adresse et par 15 min ;
  - mot de passe redemandé à un compte connecté (« Mon compte », verrouillage du lot, purge) :
    bloqué après 10 échecs. Réponse HTTP 429.
- Même temps de réponse pour un identifiant inconnu et pour un compte existant.

**Sessions**
- Jeton aléatoire 256 bits en cookie **HttpOnly**, SameSite=Lax, **Secure** en HTTPS,
  expiration 7 jours. La base n'en garde que l'**empreinte** SHA-256 : une copie de la base ne
  permet pas de se connecter à la place de quelqu'un.
- Déconnexion, changement / réinitialisation de mot de passe, suppression de compte : sessions
  supprimées et connexions temps réel (WebSocket) correspondantes fermées.

**Contrôle d'accès**
- **Toutes** les routes API et le WebSocket exigent une session valide ; chaque action est
  contrôlée selon le rôle **côté serveur** (un client trafiqué ne peut ni écrire la soutenance
  en tant qu'admin/enseignant, ni accéder aux candidats/onglets hors périmètre commission).
- WebSocket : la session est revérifiée à chaque message, et l'accès de chaque destinataire
  à chaque diffusion. Un juré retiré d'une commission (ou un enseignant retiré d'une classe)
  est prévenu et ne reçoit plus rien immédiatement ; une saisie refusée est signalée à son auteur.
- Avant verrouillage, l'établissement ne peut rien savoir de la soutenance (ni note, ni présence
  d'une note définitive) ; les notifications de verrouillage ne vont qu'aux utilisateurs ayant
  accès au candidat.

**Requêtes venant d'un autre site**
- Toute requête d'écriture et toute connexion WebSocket provenant d'une autre page que
  l'application (autre site, autre port de la même machine, sous-domaine voisin) est refusée
  (en-têtes `Sec-Fetch-Site` / `Origin`).
- En-têtes : **Content-Security-Policy** (scripts et connexions limités à l'application,
  affichage dans un cadre interdit), `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, HSTS en HTTPS ; réponses de l'API jamais mises en cache.

**Robustesse**
- SQL : exclusivement des **requêtes préparées** avec paramètres liés (pas d'injection possible).
- Entrées validées partout (types, bornes, tailles) ; cookies mal encodés, JSON malformé,
  trames WebSocket invalides → refus propre, le serveur ne tombe pas.
- WebSocket : messages de 64 Ko au plus, 300 messages par 10 s et par connexion,
  20 connexions par utilisateur.
- Les noms et identifiants saisis par les utilisateurs sont toujours affichés comme du **texte**
  (jamais interprétés en HTML) ; caractères interdits retirés avant l'écriture dans l'Excel.
- Fichiers : noms choisis par le serveur (upload et exports, avec suffixe aléatoire) ;
  téléchargement réservé à l'auteur de l'export ; upload limité à 25 Mo, `.xlsx` uniquement ;
  fichiers créés en 600, dossiers en 700.

**Limites connues**
- L'administrateur reste une personne de confiance : il peut se créer un compte de juré, ou
  réinitialiser le mot de passe d'un juré (qui s'en apercevra : son mot de passe ne marchera
  plus), et accéder ainsi à la soutenance avant verrouillage. L'application ne garde pas encore
  de journal de qui a modifié quoi.
- L'admin doit vérifier l'identité d'un juré inscrit avant de l'affecter à une commission
  (le nom affiché est déclaratif).
- Les compteurs de tentatives sont remis à zéro au redémarrage du serveur.
- Sans HTTPS (voir « Déploiement »), tout circule en clair sur le réseau.

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Express + WebSocket + API REST + contrôle d'accès |
| `auth.js` | Mots de passe (scrypt), règles des identifiants / mots de passe, sessions cookie, rôles |
| `ratelimit.js` | Limitation des tentatives (fenêtre fixe, attente croissante par compte, regroupement IPv6) |
| `test/` | Tests automatiques (`npm test`, module de test intégré à Node, sans dépendance) |
| `db.js` | SQLite (`data/evaluations.db`) : candidats, évaluations, commentaires, **verrous**, comptes, classes, commissions, paramètres ; archive/purge. Chemin surchargeable via `DB_FILE`. |
| `excel.js` | Génération des copies Excel remplies |
| `hierarchy.js` | Grilles des 5 onglets + mapping lignes/colonnes Excel |
| `public/` | Frontend (login, candidats, saisie, administration) |
| `uploads/` | Fichiers Excel associés aux candidats |
| `exports/` | Copies générées à télécharger (supprimées après téléchargement ou au bout d'une heure) |

> **Note** : `todo.html` est l'ancienne version statique, conservée pour référence.
