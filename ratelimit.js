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

/* Attente croissante (par compte, toutes adresses confondues) : après
   `freeAttempts` échecs, chaque nouvelle tentative doit attendre
   baseMs × 2^(échecs au-delà), plafonné à maxMs. Les échecs sont oubliés
   après `forgetMs` sans nouvel échec. Contre une attaque répartie sur de
   nombreuses adresses, sans bloquer définitivement le vrai titulaire. */
function createBackoff({ freeAttempts, baseMs, maxMs, forgetMs }) {
  const state = new Map(); // clé -> { failures, last }

  function sweep(now) {
    if (state.size < 1000) return;
    for (const [key, e] of state) if (now - e.last > forgetMs) state.delete(key);
  }
  function current(key, now) {
    const e = state.get(key);
    if (e && now - e.last > forgetMs) { state.delete(key); return null; }
    return e || null;
  }

  return {
    blockedFor(key) {
      const now = Date.now();
      const e = current(key, now);
      if (!e || e.failures < freeAttempts) return 0;
      const delay = Math.min(maxMs, baseMs * 2 ** (e.failures - freeAttempts));
      const remaining = e.last + delay - now;
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    },
    hit(key) {
      const now = Date.now();
      sweep(now);
      const e = current(key, now) || { failures: 0, last: now };
      e.failures++;
      e.last = now;
      state.set(key, e);
    },
    reset(key) { state.delete(key); },
  };
}

/* Clé de limitation pour une adresse IP. En IPv6, un même abonné dispose
   en général de tout un bloc /64 : on regroupe donc par /64 (sinon chaque
   adresse du bloc aurait son propre compteur). */
function clientKey(ip) {
  const s = String(ip || "");
  if (!s.includes(":")) return s;                         // IPv4
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];                           // IPv4 vue en IPv6
  const [head, tail] = s.split("%")[0].split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

// Réponse 429 standard, avec l'en-tête Retry-After
function tooManyAttempts(res, seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  res.setHeader("Retry-After", String(seconds));
  return res.status(429).json({
    error: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`,
  });
}

module.exports = { createLimiter, createBackoff, clientKey, tooManyAttempts };
