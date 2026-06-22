/// <reference lib="webworker" />
/**
 * Service worker (vite-plugin-pwa `injectManifest` mode — this file is OURS,
 * the plugin only injects the precache list at `self.__WB_MANIFEST`).
 *
 * Responsibilities:
 *  - Precache the whole app shell: HTML, every hashed JS chunk **including the
 *    lazy worker/pipeline chunk that index.html never references**, CSS and
 *    icons. That lazy chunk is the one a hand-rolled glob would silently miss,
 *    which is exactly why we let the plugin glob the real `dist/` output.
 *  - Serve the shell cache-first (Workbox precaching is cache-first by design),
 *    so the app — and a full mesh build + STL/OBJ export — works with NO network.
 *  - Use versioned, self-cleaning caches (Workbox names its precache
 *    `workbox-precache-v2-<scope>` and bumps revisions per file; we additionally
 *    call `cleanupOutdatedCaches()` so stale precaches are deleted on activate).
 *  - Never touch a third-party origin: every precached URL is same-origin.
 */
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import type { PrecacheEntry } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// Drop precaches from previous SW versions on activate.
cleanupOutdatedCaches();

// The complete, revisioned precache manifest is injected here at build time.
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback: any navigation request is served the precached
// index.html from cache, so reloading the app while offline still boots.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// `registerType: 'prompt'` flow: virtual:pwa-register posts SKIP_WAITING when
// the user taps "Reload" in the update toast; activating then triggers the
// plugin's controllerchange reload. We do NOT call skipWaiting() eagerly, so a
// running build is never interrupted by a silent swap.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
