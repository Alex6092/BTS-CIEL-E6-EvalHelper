/* ════════════════════════════════════════════════════════════════
   ratelimit.js  —  Limitation du nombre de tentatives (en mémoire)
   Fenêtre fixe par clé (adresse IP, IP + identifiant, utilisateur…).
   Sert à freiner les essais de mots de passe en série et les
   inscriptions massives. Les compteurs sont perdus au redémarrage
   du serveur, ce qui est acceptable pour cet usage.
   ════════════════════════════════════════════════════════════════ */

function createLimiter({ windowMs, max }) {
  const hits = new Map(); // clé -> { count, resetAt }

  // Évite que la table grossisse indéfiniment
  function sweep(now) {
    if (hits.size < 1000) return;
    for (const [key, e] of hits) if (e.resetAt <= now) hits.delete(key);
  }

  return {
    // Secondes restantes avant déblocage si la clé est bloquée, sinon 0
    blockedFor(key) {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || e.resetAt <= now || e.count < max) return 0;
      return Math.ceil((e.resetAt - now) / 1000);
    },
    // Compte une tentative pour cette clé
    hit(key) {
      const now = Date.now();
      sweep(now);
      let e = hits.get(key);
      if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        hits.set(key, e);
      }
      e.count++;
    },
    // Remet le compteur à zéro (ex. après une connexion réussie)
    reset(key) { hits.delete(key); },
  };
}

// Réponse 429 standard, avec l'en-tête Retry-After
function tooManyAttempts(res, seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json({
    error: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`,
  });
}

module.exports = { createLimiter, tooManyAttempts };
