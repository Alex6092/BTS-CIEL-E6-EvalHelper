/* ════════════════════════════════════════════════════════════════
   hierarchy.js  —  Données partagées (compétences + mapping Excel)
   Utilisable côté Node (require) ET côté navigateur (window.HIERARCHY).
   ════════════════════════════════════════════════════════════════ */

/*
  Mapping Excel :
  - Les lignes sont IDENTIQUES pour les deux onglets cibles
    ("E6 REVUES - IR - R3" et "E6 SOUTENANCE - IR").
  - Colonnes : C = Niveau 1 (0 obs / rouge), D = Niveau 2 (1 obs / jaune),
               E = Niveau 3 (2-3 obs / bleu), F = Niveau 4 (4 obs / vert).
  - On écrit un "x" dans la colonne correspondant à la pastille.
*/

(function () {
const SHEETS = {
  R3: "E6 REVUES - IR - R3",
  SO: "E6 SOUTENANCE - IR",
};

const HIERARCHY = [
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
          { id: "C03-1-4", text: "L'avancement est réel et témoigne de son implication dans le projet." },
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

/* Pastille / colonne Excel à partir du nombre de sous-critères cochés.
   0 -> rouge / C (Niveau 1)
   1 -> jaune / D (Niveau 2)
   tous -> vert / F (Niveau 4)
   sinon (2-3, mais pas tous) -> bleu / E (Niveau 3) */
function computeLevel(checkedCount, total) {
  if (total === 0) return { color: "red", col: "C", level: 1 };
  if (checkedCount === 0)        return { color: "red",    col: "C", level: 1 };
  if (checkedCount === 1)        return { color: "yellow", col: "D", level: 2 };
  if (checkedCount === total)    return { color: "green",  col: "F", level: 4 };
  return { color: "blue", col: "E", level: 3 };
}

/* Liste à plat de tous les IDs de sous-critères (feuilles) */
function allLeafIds() {
  const ids = [];
  for (const section of HIERARCHY)
    for (const item of section.items)
      for (const child of (item.children || []))
        ids.push(child.id);
  return ids;
}

// ── Export universel (Node + navigateur) ──
const API = { SHEETS, HIERARCHY, computeLevel, allLeafIds };
if (typeof module !== "undefined" && module.exports) {
  module.exports = API;
} else {
  window.HIERARCHY_DATA = API;
}
})();
