/* ════════════════════════════════════════════════════════════════
   hierarchy.js  —  Données des grilles d'évaluation (5 onglets)
   Module Node uniquement : le navigateur reçoit tout via /api/hierarchy.

   Onglets :
   - STAGE : lignes décalées (+1) et observables spécifiques
   - R1    : mêmes critères que R3 mais C08 et C10 NON ÉVALUÉS
   - R2/R3/SO : grille identique (mêmes lignes, mêmes observables)

   Colonnes de niveau (toutes grilles) :
   C = Niveau 1 (0 obs / rouge), D = Niveau 2 (1 obs / jaune),
   E = Niveau 3 (2-3 obs / bleu), F = Niveau 4 (tous / vert).
   ════════════════════════════════════════════════════════════════ */

/* ── Configuration par onglet ──
   info : cellules où écrire les en-têtes (haut-gauche des fusions)
   commentCell : cellule du commentaire (sous le libellé "Commentaire ...") */
const SHEET_CONFIG = {
  STAGE: {
    name: "E6 STAGE - IR", label: "Stage",
    info: { academie: "E8", etablissement: "E9", nom: "E10", prenom: "E11", numero: "E12", date: "E13" },
    commentCell: "A9",
  },
  R1: {
    name: "E6 REVUES - IR - R1", label: "Revue 1",
    info: { academie: "E7", etablissement: "E8", nom: "E9", prenom: "E10", numero: "E11", date: "E12" },
    commentCell: "A8",
  },
  R2: {
    name: "E6 REVUES - IR - R2", label: "Revue 2",
    info: { academie: "E7", etablissement: "E8", nom: "E9", prenom: "E10", numero: "E11", date: "E12" },
    commentCell: "A8",
  },
  R3: {
    name: "E6 REVUES - IR - R3", label: "Revue 3",
    info: { academie: "E7", etablissement: "E8", nom: "E9", prenom: "E10", numero: "E11", date: "E12" },
    commentCell: "A8",
  },
  SO: {
    name: "E6 SOUTENANCE - IR", label: "Soutenance",
    info: { academie: "E7", etablissement: "E8", nom: "E9", prenom: "E10", numero: "E11", date: "E12" },
    commentCell: "A8",
  },
};

const SHEET_ORDER = ["STAGE", "R1", "R2", "R3", "SO"];

/* ════════════════ Grille commune R2 / R3 / SO ════════════════ */
const BASE_HIERARCHY = [
  {
    id: "C01",
    title: "C01 – Communiquer en situation professionnelle",
    items: [
      {
        id: "C01-1", excelRow: 20,
        text: "Le rapport (typographie, orthographe, illustration, lisibilité) est soigné, personnel et argumenté avec des enchaînements cohérents",
        children: [
          { id: "C01-1-1", text: "La page de titre contient les informations utiles (nom du candidat, nom de l'entreprise, année, nom du lycée, BTS et option) ainsi qu'une illustration adaptée. Les entêtes et pieds de pages contiennent au minimum le numéro de la page et le nom du candidat. Le sommaire automatique est présenté sur une seule page." },
          { id: "C01-1-2", text: "La page de titre contient les informations utiles (nom du candidat, année, nom du lycée, BTS et option) ainsi qu'une illustration adaptée. Le sommaire automatique est présenté sur une seule page." },
          { id: "C01-1-3", text: "Les entêtes et pieds de pages contiennent au minimum le numéro de la page et le nom du candidat qui a écrit cette page." },
          { id: "C01-1-4", text: "Les chapitres s'enchaînent de façon logique, chaque chapitre est introduit par une phrase et conclu par une phrase. Chaque illustration est expliquée ou présentée avec une légende." },
        ]
      },
      {
        id: "C01-2", excelRow: 21,
        text: "La présentation (typographie, orthographe, illustration, lisibilité) est soignée et soutient le discours avec des enchaînements cohérents",
        children: [
          { id: "C01-2-1", text: "Le support est un travail personnel et ne comporte pas de faute d'orthographe. La typographie et les illustrations sont soignées afin de rendre le support lisible. La police est adaptée." },
          { id: "C01-2-2", text: "Le plan est proposé et cohérent." },
          { id: "C01-2-3", text: "L'introduction et la conclusion sont présentes." },
          { id: "C01-2-4", text: "Les informations choisies sont synthétiques et elles sont support du discours." },
        ]
      },
      {
        id: "C01-3", excelRow: 22,
        text: "La présentation orale est de qualité et claire",
        children: [
          { id: "C01-3-1", text: "Le temps de parole est respecté." },
          { id: "C01-3-2", text: "Détachement des notes. S'exprime en regardant l'auditoire." },
          { id: "C01-3-3", text: "L'expression est de qualité : le langage est distinct, fluide et non familier." },
          { id: "C01-3-4", text: "L'exposé est clair et les idées s'enchainent logiquement. Le candidat utilise l'espace pour sa présentation." },
        ]
      },
      {
        id: "C01-4", excelRow: 23,
        text: "L'argumentation lors de l'échange est de qualité",
        children: [
          { id: "C01-4-1", text: "L'échange est courtois." },
          { id: "C01-4-2", text: "Le candidat écoute les questions du jury, les reformule s'il ne les comprend pas." },
          { id: "C01-4-3", text: "Les réponses apportées sont appropriées et témoignent d'une capacité à mobiliser ses connaissances à bon escient et à les exposer clairement." },
          { id: "C01-4-4", text: "Des arguments sont utilisés et les erreurs sont corrigées." },
        ]
      },
      {
        id: "C01-SE", excelRow: 25, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C01-5", text: "Le style, le ton et la terminologie utilisés sont adaptés à la personne et aux circonstances, notamment les éventuelles situations de handicap des personnes sont prises en compte." },
          { id: "C01-6", text: "L'attitude, les comportements et le langage adoptés sont conformes aux règles de la profession, la réaction est adaptée au contexte." },
        ]
      },
    ]
  },
  {
    id: "C03",
    title: "C03 – Gérer un projet",
    items: [
      {
        id: "C03-1", excelRow: 32,
        text: "Les documents de suivis des tâches sont renseignés, le planning prévisionnel est mis à jour. Les éventuelles situation de handicap sont prisent en compte.",
        children: [
          { id: "C03-1-1", text: "Les taches de l'ensemble de l'équipe sont présentées via par exemple un diagramme de Gantt." },
          { id: "C03-1-2", text: "L'avancement de chaque tâche est renseigné." },
          { id: "C03-1-3", text: "L'avancement est réel et témoigne de son implication dans le projet." },
        ]
      },
      {
        id: "C03-2", excelRow: 33,
        text: "L'adéquation des ressources humaines et des ressources matérielles pour mener le projet est validée",
        children: [
          { id: "C03-2-1", text: "L'architecture des composants logiciels et matériels du projet sont présentés, un diagramme SYSML de bd/ibd ou UML déploiement est utilisé pour cela." },
          { id: "C03-2-2", text: "Les moyens disponibles pour réaliser le projet sont présentés." },
          { id: "C03-2-3", text: "Le périmètre de chaque candidat est identifié." },
          { id: "C03-2-4", text: "La présentation du périmètre fonctionnel de chacun des candidats est faite par un diagramme de cas d'utilisation." },
        ]
      },
      {
        id: "C03-3", excelRow: 34,
        text: "L'équipe projet communique correctement et gère les retards et aléas",
        children: [
          { id: "C03-3-1", text: "Un espace collaboratif (partage et modification de documents, suivi de projet, etc.) est présenté." },
          { id: "C03-3-2", text: "La mise en œuvre de l'espace collaboratif est démontrée." },
          { id: "C03-3-3", text: "Le planning effectif est comparé au planning prévisionnel pour permettre un constat." },
          { id: "C03-3-4", text: "L'écart entre le temps prévisionnel et le temps réalisé est justifié." },
        ]
      },
      {
        id: "C03-4", excelRow: 35,
        text: "Les travaux sont réalisés et livrés avec la documentation en concordance avec les besoins du client",
        children: [
          { id: "C03-4-1", text: "Les différents reportings et versionings sont listés et présentés." },
          { id: "C03-4-2", text: "Un espace collaboratif contient les différentes versions de livraison du projet." },
          { id: "C03-4-3", text: "La dernière livraison est intégrée et packagée." },
          { id: "C03-4-4", text: "Un cahier de recette est présenté pour démontrer les concordances entre les besoins et la réalisation." },
        ]
      },
      {
        id: "C03-SE", excelRow: 37, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C03-5", text: "Le travail est préparé de façon à satisfaire les exigences de qualité, d'efficacité et d'échéancier." },
          { id: "C03-6", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens conformément aux règles de la fonction." },
          { id: "C03-7", text: "Le travail en équipe est conduit de manière solidaire en contribuant par des idées et des efforts." },
        ]
      },
    ]
  },
  {
    id: "C08",
    title: "C08 – Coder",
    items: [
      {
        id: "C08-1", excelRow: 44,
        text: "Les environnements sont choisis et justifiés et les données de l'entreprise sont identifiées",
        children: [
          { id: "C08-1-1", text: "Le choix de l'environnement de développement est justifié." },
          { id: "C08-1-2", text: "Les librairies utilisées sont justifiées." },
          { id: "C08-1-3", text: "Les contraintes du client sont identifiées (cybersécurité, matériels, capteurs ...)." },
          { id: "C08-1-4", text: "Un diagramme présente l'architecture des données (Base de données, XML, JSON ...)." },
        ]
      },
      {
        id: "C08-2", excelRow: 45,
        text: "Le code est versionné, commenté et le logiciel est documenté",
        children: [
          { id: "C08-2-1", text: "Un outil de versionnement est en place." },
          { id: "C08-2-2", text: "Le fonctionnement de l'outil de versionnement est démontré." },
          { id: "C08-2-3", text: "Chaque composant est versionné." },
          { id: "C08-2-4", text: "Chaque composant est documenté." },
        ]
      },
      {
        id: "C08-3", excelRow: 46,
        text: "Les composants logiciels individuels sont développés conformément aux spécifications du cahier des charges, des bonnes pratiques et des différentes politiques de sécurité et de protection des données personnelles",
        children: [
          { id: "C08-3-1", text: "Les tests unitaires sont réalisés et tracés dans un cahier." },
          { id: "C08-3-2", text: "Le test unitaire permet de valider les spécifications." },
          { id: "C08-3-3", text: "Les interfaces entre les composants sont documentées par un diagramme de classes ou équivalent." },
          { id: "C08-3-4", text: "La politique de protection des données est présentée et justifiée." },
        ]
      },
      {
        id: "C08-4", excelRow: 47,
        text: "La solution (logicielle et matérielle) est intégrée et testée conformément aux spécifications du cahier des charges, des bonnes pratiques et des différentes politiques de sécurité et de protection des données personnelles",
        children: [
          { id: "C08-4-1", text: "Les composants du projet sont intégrés." },
          { id: "C08-4-2", text: "Une recette permet de valider les spécifications." },
          { id: "C08-4-3", text: "Pour chaque cas d'utilisation : Le cas nominal et les scénarios alternatifs sont conformes." },
          { id: "C08-4-4", text: "La politique de protection des données est présentée et justifiée." },
        ]
      },
      {
        id: "C08-SE", excelRow: 49, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C08-5", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens conformément aux règles de la fonction." },
          { id: "C08-6", text: "Le travail est effectué selon les attentes exprimées de temps, de quantité ou de qualité." },
          { id: "C08-7", text: "Le travail est préparé de façon à satisfaire les exigences de qualité, d'efficacité et d'échéancier." },
        ]
      },
    ]
  },
  {
    id: "C10",
    title: "C10 – Exploiter un réseau informatique",
    items: [
      {
        id: "C10-1", excelRow: 56,
        text: "Les différents éléments matériels et/ou logiciels sont identifiés à partir d'un schéma fourni",
        children: [
          { id: "C10-1-1", text: "L'architecture matérielle du projet est présentée." },
          { id: "C10-1-2", text: "Un diagramme de réseau ou équivalent est utilisé pour la présentation." },
          { id: "C10-1-3", text: "L'architecture des composants logiciels du projet est présentée, un diagramme UML de déploiement ou équivalent est utilisé." },
          { id: "C10-1-4", text: "Le choix des matériels (actionneurs/capteurs) est justifié." },
        ]
      },
      {
        id: "C10-2", excelRow: 57,
        text: "Le fonctionnement d'un équipement matériel et/ou logiciel est vérifié en tenant compte du contexte",
        children: [
          { id: "C10-2-1", text: "Le fonctionnement des matériels (actionneurs/capteurs) est explicité." },
          { id: "C10-2-2", text: "La mise en œuvre des capteurs est démontrée." },
          { id: "C10-2-3", text: "La communication et le format des données échangées entre les matériels sont analysés et documentés." },
          { id: "C10-2-4", text: "Les outils d'analyse réseau sont maîtrisés (oscillogramme, sniffeur, ping, traceroute, telnet ...)." },
        ]
      },
      {
        id: "C10-3", excelRow: 58,
        text: "La mise à jour d'un matériel et/ou logiciel est proposée et justifiée",
        children: [
          { id: "C10-3-1", text: "Les versions des matériels et logiciels sont listées." },
          { id: "C10-3-2", text: "Les logiciels, pilotes sont à jours." },
          { id: "C10-3-3", text: "La configuration des éléments matériels et logiciel sont à même de permettre une bonne résistance aux attaques." },
          { id: "C10-3-4", text: "Les enjeux de la cybersécurité (faille de sécurité, signature, certificats ...) des mises à jour sont pris en compte." },
        ]
      },
      {
        id: "C10-4", excelRow: 59,
        text: "Les optimisations ou résolution d'incidents nécessaires sont effectuées",
        children: [
          { id: "C10-4-1", text: "Les outils de diagnostic sont connus." },
          { id: "C10-4-2", text: "L'outil adéquat est utilisé pour le test." },
          { id: "C10-4-3", text: "Le résultat de l'outil de test est correctement interprété." },
          { id: "C10-4-4", text: "La mise au point ou la résolution d'incident est correcte." },
        ]
      },
      {
        id: "C10-SE", excelRow: 61, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C10-5", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens." },
          { id: "C10-6", text: "Le travail en équipe est conduit de manière solidaire en contribuant par des idées et des efforts." },
          { id: "C10-7", text: "Face à un ensemble de faits, des actions appropriées à poser sont décidées." },
        ]
      },
    ]
  },
];

/* ════════════════ Grille STAGE (observables spécifiques) ════════════════ */
const STAGE_HIERARCHY = [
  {
    id: "C01",
    title: "C01 – Communiquer en situation professionnelle",
    items: [
      {
        id: "C01-1", excelRow: 21,
        text: "Le rapport (typographie, orthographe, illustration, lisibilité) est soigné, personnel et argumenté avec des enchaînements cohérents.",
        children: [
          { id: "C01-1-1", text: "La page de titre contient les informations utiles (nom du candidat, nom de l'entreprise, année, nom du lycée, BTS et option) ainsi qu'une illustration adaptée. Les entêtes et pieds de pages contiennent au minimum le numéro de la page et le nom du candidat. Le sommaire automatique est présenté sur une seule page." },
          { id: "C01-1-2", text: "L'introduction est claire et logique, elle présente bien le contenu du rapport." },
          { id: "C01-1-3", text: "La conclusion est intéressante, un bilan du stage est rédigé, et des perspectives sont présentées." },
        ]
      },
      {
        id: "C01-2", excelRow: 22,
        text: "Le support de présentation (typographie, orthographe, illustration, lisibilité) est soigné et soutient le discours avec des enchaînements cohérents.",
        children: [
          { id: "C01-2-1", text: "L'entreprise est présentée (type d'entreprise, raison sociale, le service informatique et son fonctionnement)." },
          { id: "C01-2-2", text: "Le vocabulaire technique est expliqué, les logiciels utilisés et les matériels réseaux sont présentés." },
          { id: "C01-2-3", text: "La conclusion et l'introduction sont claires, précises et intéressantes, un bilan et les perspectives sont présentées." },
        ]
      },
      {
        id: "C01-3", excelRow: 23,
        text: "La présentation orale est de qualité et claire",
        children: [
          { id: "C01-3-1", text: "Respect du temps de parole = 15 minutes." },
          { id: "C01-3-2", text: "Détachement des notes. S'exprime en regardant l'auditoire." },
          { id: "C01-3-3", text: "Qualité de l'expression : expression distincte, fluide, non familière." },
          { id: "C01-3-4", text: "Clarté de l'exposé. Enchaînement logique des idées, argumentation." },
        ]
      },
      {
        id: "C01-4", excelRow: 24,
        text: "L'argumentation lors de l'échange est de qualité",
        children: [
          { id: "C01-4-1", text: "L'échange est courtois." },
          { id: "C01-4-2", text: "Le candidat écoute les questions du jury, les reformule s'il ne les comprend pas." },
          { id: "C01-4-3", text: "Les réponses apportées sont appropriées et témoignent d'une capacité à mobiliser ses connaissances à bon escient et à les exposer clairement." },
          { id: "C01-4-4", text: "Des arguments sont utilisés et les erreurs sont corrigées." },
        ]
      },
      {
        id: "C01-SE", excelRow: 26, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C01-5", text: "Le style, le ton et la terminologie utilisés sont adaptés à la personne et aux circonstances, notamment les éventuelles situations de handicap des personnes sont prises en compte." },
          { id: "C01-6", text: "L'attitude, les comportements et le langage adoptés sont conformes aux règles de la profession, la réaction est adaptée au contexte." },
        ]
      },
    ]
  },
  {
    id: "C03",
    title: "C03 – Gérer un projet",
    items: [
      {
        id: "C03-1", excelRow: 33,
        text: "Les documents de suivis des tâches sont renseignés, le planning prévisionnel est mis à jour. Les éventuelles situation de handicap sont prisent en compte.",
        children: [
          { id: "C03-1-1", text: "Les documents / logiciels de suivi des activités professionnelles sont identifiés (GMAO, GLPI, comptes-rendus d'interventions…)." },
          { id: "C03-1-2", text: "Les documents / logiciels de suivi des activités professionnelles sont utilisés à bon escient." },
          { id: "C03-1-3", text: "Les méthodes de conduite de projet ou à défaut celles d'organisation du temps de travail dans la structure sont identifiées." },
          { id: "C03-1-4", text: "Le reporting hebdomadaire du stage / du projet est présenté." },
        ]
      },
      {
        id: "C03-2", excelRow: 34,
        text: "L'adéquation des ressources humaines et des ressources matérielles pour mener le projet est validée.",
        children: [
          { id: "C03-2-1", text: "Les fonctions de chaque service côtoyé par l'entreprise sont identifiées par l'étudiant." },
          { id: "C03-2-2", text: "Sur un des projets ou une des activités de l'entreprise, les ressources matérielles sont identifiées." },
          { id: "C03-2-3", text: "Sur un des projets ou une des activités de l'entreprise, les différents acteurs du projet (sous-traitants, clients, prestataires, fournisseurs, maitre d'œuvre, maitre d'ouvrage, utilisateurs, exploitants) sont identifiés par l'étudiant." },
          { id: "C03-2-4", text: "La composition du service d'accueil de l'étudiant est présentée." },
        ]
      },
      {
        id: "C03-3", excelRow: 35,
        text: "L'équipe projet communique correctement et gère les retards et les aléas",
        children: [
          { id: "C03-3-1", text: "Les échanges liés aux projets et/ou aux activités dans l'entreprise sont identifiés, notamment à travers les réunions de suivi, les courriels, les relations clients / fournisseurs..." },
          { id: "C03-3-2", text: "L'étudiant participe aux réunions d'équipe et aux communications professionnelles de l'entreprise." },
          { id: "C03-3-3", text: "L'équipe projet ou l'équipe en charge de l'activité est identifiée, le rôle de chacun est connu." },
          { id: "C03-3-4", text: "Les retards et aléas potentiels sont identifiés et pris en compte." },
        ]
      },
      {
        id: "C03-4", excelRow: 36,
        text: "Les travaux sont réalisés et livrés avec la documentation en concordance avec les besoins du client",
        children: [
          { id: "C03-4-1", text: "L'étudiant reformule les besoins du client liés à son stage." },
          { id: "C03-4-2", text: "Un reporting régulier à minima hebdomadaire est fait par l'étudiant à son tuteur." },
          { id: "C03-4-3", text: "L'étudiant présente les retours qu'il a fait sur les taches qui lui ont été confiées." },
          { id: "C03-4-4", text: "Les documentations liées aux travaux effectués par le stagiaire sont présentées." },
        ]
      },
      {
        id: "C03-SE", excelRow: 38, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C03-5", text: "Le travail est préparé de façon à satisfaire les exigences de qualité, d'efficacité et d'échéancier." },
          { id: "C03-6", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens conformément aux règles de la fonction." },
          { id: "C03-7", text: "Le travail en équipe est conduit de manière solidaire en contribuant par des idées et des efforts." },
        ]
      },
    ]
  },
  {
    id: "C08",
    title: "C08 – Coder",
    items: [
      {
        id: "C08-1", excelRow: 45,
        text: "Les environnements sont choisis et justifiés et les données de l'entreprise sont identifiées",
        children: [
          { id: "C08-1-1", text: "Les missions et/ou le cahier des charges du stage sont présentés." },
          { id: "C08-1-2", text: "Le contexte technique est présenté (matériels et logiciels)." },
          { id: "C08-1-3", text: "L'environnement technique est justifié vis à vis de l'activité." },
          { id: "C08-1-4", text: "Des diagrammes permettent de synthétiser le contexte." },
        ]
      },
      {
        id: "C08-2", excelRow: 46,
        text: "Le code est versionné, commenté et le logiciel est documenté",
        children: [
          { id: "C08-2-1", text: "Le versionnement et l'archivage des différents logiciels/matériels sont présentés." },
          { id: "C08-2-2", text: "Les différents documents de la vie de l'entreprise sont présentés." },
          { id: "C08-2-3", text: "Les cycles de tests matériels/logiciels sont présentés." },
          { id: "C08-2-4", text: "Les documents créés ou complétés par le stagiaire sont présentés." },
        ]
      },
      {
        id: "C08-3", excelRow: 47,
        text: "Les composants logiciels individuels sont développés et la solution (logicielle et matérielle) est intégrée et testée conformément aux spécifications du cahier des charges, des bonnes pratiques et des différentes politiques de sécurité et de protection des données personnelles",
        children: [
          { id: "C08-3-1", text: "Un bilan technique de chaque mission ou projet est présenté." },
          { id: "C08-3-2", text: "Une analyse des retards et des aléas est présentée." },
          { id: "C08-3-3", text: "Les documents règlementaires (CNIL/RGPD/ISO.../ règlementation sectorielle) normatifs adoptés au sein de l'entreprise et du secteur de la sécurité des systèmes d'information sont présentés." },
          { id: "C08-3-4", text: "Des propositions sont émises afin d'améliorer la cybersécurité dans l'entreprise." },
        ]
      },
      {
        id: "C08-SE", excelRow: 49, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C08-5", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens conformément aux règles de la fonction." },
          { id: "C08-6", text: "Le travail est effectué selon les attentes exprimées de temps, de quantité ou de qualité." },
          { id: "C08-7", text: "Le travail est préparé de façon à satisfaire les exigences de qualité, d'efficacité et d'échéancier." },
        ]
      },
    ]
  },
  {
    id: "C10",
    title: "C10 – Exploiter un réseau informatique",
    items: [
      {
        id: "C10-1", excelRow: 56,
        text: "Les différents éléments matériels et/ou logiciels sont identifiés à partir d'un schéma fourni",
        children: [
          { id: "C10-1-1", text: "Les différents éléments matériels et/ou logiciels du système d'information de l'entreprise sont identifiés." },
          { id: "C10-1-2", text: "Un diagramme de réseau ou équivalent est utilisé pour les présenter." },
          { id: "C10-1-3", text: "Le rôle des différents éléments est compris." },
          { id: "C10-1-4", text: "Les caractéristiques permettant de choisir ou comparer les éléments sont appréhendées." },
        ]
      },
      {
        id: "C10-2", excelRow: 57,
        text: "Le fonctionnement de certains équipements matériels et/ou logiciels du système d'information est expliqué",
        children: [
          { id: "C10-2-1", text: "Le fonctionnement de certains équipements matériels du système d'information est expliqué." },
          { id: "C10-2-2", text: "Les matériels de couche 2 sont présentés." },
          { id: "C10-2-3", text: "Les matériels de couche 3 sont présentés ainsi que les interconnexions." },
          { id: "C10-2-4", text: "Le fonctionnement de certains équipements logiciels du système d'information est expliqué." },
        ]
      },
      {
        id: "C10-3", excelRow: 58,
        text: "La mise à jour d'un matériel et/ou logiciel est proposée et justifiée",
        children: [
          { id: "C10-3-1", text: "Une activité réalisée par le stagiaire est décrite." },
          { id: "C10-3-2", text: "La présentation de l'activité est qualitative et permet de comprendre le rôle de l'étudiant et son apport." },
          { id: "C10-3-3", text: "L'objectif de cette activité est justifié." },
          { id: "C10-3-4", text: "Les procédures de mise à jour des logiciels et renouvellements matériels de l'entreprise sont présentés." },
        ]
      },
      {
        id: "C10-4", excelRow: 59,
        text: "Les optimisations ou résolution d'incidents nécessaires sont effectuées",
        children: [
          { id: "C10-4-1", text: "Les procédures internes (GLPI, GMAO, processus internes…) sont suivies par l'étudiant." },
          { id: "C10-4-2", text: "Les tests sont réalisés en suivant les procédures, le défaut est identifié, corrigé, le PV d'anomalie est rédigé." },
          { id: "C10-4-3", text: "Les documentations relatives à l'installation ou la procédure d'intervention sont éventuellement mises à jour." },
          { id: "C10-4-4", text: "Le stagiaire peut présenter l'analyse de ses pratiques sur l'activité réalisée et en dresser un bilan." },
        ]
      },
      {
        id: "C10-SE", excelRow: 61, savoirEtre: true,
        text: "Savoir-être",
        children: [
          { id: "C10-5", text: "La résolution d'un problème nouveau imprévu est réussie en utilisant ses propres moyens." },
          { id: "C10-6", text: "Le travail en équipe est conduit de manière solidaire en contribuant par des idées et des efforts." },
          { id: "C10-7", text: "Face à un ensemble de faits, des actions appropriées à poser sont décidées." },
        ]
      },
    ]
  },
];

/* R1 : mêmes critères que la grille commune, mais C08 et C10 ne sont
   pas évalués (zones "NON EVALUE" fusionnées dans l'Excel — interdiction
   d'y écrire). */
const R1_HIERARCHY = BASE_HIERARCHY.filter(s => s.id === "C01" || s.id === "C03");

const HIERARCHIES = {
  STAGE: STAGE_HIERARCHY,
  R1: R1_HIERARCHY,
  R2: BASE_HIERARCHY,
  R3: BASE_HIERARCHY,
  SO: BASE_HIERARCHY,
};

/* Pastille / colonne Excel à partir du nombre de sous-critères cochés.
   0 -> rouge / C (Niveau 1)
   1 -> jaune / D (Niveau 2)
   tous -> vert / F (Niveau 4)
   sinon -> bleu / E (Niveau 3) */
function computeLevel(checkedCount, total) {
  if (total === 0 || checkedCount === 0) return { color: "red", col: "C", level: 1 };
  if (checkedCount === 1 && total > 1)   return { color: "yellow", col: "D", level: 2 };
  if (checkedCount === total)            return { color: "green", col: "F", level: 4 };
  return { color: "blue", col: "E", level: 3 };
}

/* IDs valides (feuilles) pour un onglet donné */
function allLeafIds(sheetKey) {
  const ids = new Set();
  for (const section of (HIERARCHIES[sheetKey] || []))
    for (const item of section.items)
      for (const child of (item.children || []))
        ids.add(child.id);
  return ids;
}

module.exports = { SHEET_CONFIG, SHEET_ORDER, HIERARCHIES, computeLevel, allLeafIds };
