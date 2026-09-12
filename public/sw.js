/**
 * Zademi customer-card service worker.
 *
 * This file is deliberately almost empty, and that is the design.
 *
 * A service worker is what makes a card installable, and installability is all Phase 1a claims.
 * It is registered per card, with the card's own path as its scope (see CardPwa.tsx), so three
 * cards from three cafés are three registrations with three caches rather than one worker that
 * can see all of them.
 *
 * ## What it must never do, and why
 *
 * A card page is personal: it carries a balance, a name and a scanner token. A cache-first
 * strategy would leave that data in the browser's cache storage after the customer stops using
 * the card, and would serve a stale balance that disagrees with the counter — the one thing a
 * loyalty card must never do. Staff pages and scanner actions are worse: caching an authenticated
 * response could hand one cashier another's screen.
 *
 * So this worker caches NOTHING:
 *
 *  - no card pages, no API responses, no enrollment POSTs, no staff or scanner pages;
 *  - no offline fallback, because there is no cached state to fall back to.
 *
 * Every request goes to the network exactly as it would without a worker. `fetch` is not even
 * intercepted, which is the clearest way to say so: with no `fetch` handler, the browser does not
 * route requests through this worker at all.
 *
 * ## What comes later
 *
 * Offline card state, web push with VAPID keys, `lastOpenedAt` telemetry and card restore are
 * Phase 1.5. Each one changes this file deliberately, with its own tests. Until then, an
 * installed card is an ordinary online page in an app window.
 */

/*
 * The cache prefix is part of the rebrand only because the cleanup below matches on it. This worker
 * caches NOTHING, so there is no cached content to migrate: the rename simply means the sweep that
 * deletes stale caches keeps deleting the old `walaaplus-` ones as well as any future `zademi-` one.
 */
const SW_VERSION = "zademi-card-v1";

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab of this card to close. Safe precisely
  // because nothing is cached: there is no old cache to serve and no migration to perform.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Belt and braces: if a future version ever caches something and is then rolled back, this
      // removes what it left behind rather than serving it forever.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => /^(walaaplus|zademi)-/.test(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// Deliberately no `fetch` listener. See the note above.

self.addEventListener("message", (event) => {
  if (event.data === "version") event.source?.postMessage(SW_VERSION);
});
