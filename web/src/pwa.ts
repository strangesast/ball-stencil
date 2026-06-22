/**
 * PWA glue: service-worker registration + update/offline/install UI.
 *
 * Uses vite-plugin-pwa's `virtual:pwa-register` in `prompt` mode. The plugin
 * owns the skipWaiting / clients.claim / controllerchange reload-once dance —
 * we only render non-intrusive toasts and forward the user's intent. We never
 * add our own controllerchange reload (that reintroduces reload loops).
 */
import { registerSW } from "virtual:pwa-register";

type ToastAction = { label: string; onClick: () => void };

function toast(message: string, opts: { action?: ToastAction; timeout?: number } = {}) {
  const host = document.getElementById("toasts");
  if (!host) return () => {};
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "toast-msg";
  text.textContent = message;
  el.appendChild(text);

  const dismiss = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };

  if (opts.action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      opts.action!.onClick();
      dismiss();
    });
    el.appendChild(btn);
  }
  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", dismiss);
  el.appendChild(close);

  host.appendChild(el);
  if (opts.timeout) setTimeout(dismiss, opts.timeout);
  return dismiss;
}

export function initPwa() {
  // registerSW returns a function to apply the waiting update + reload.
  const updateSW = registerSW({
    onNeedRefresh() {
      showUpdate();
    },
    onOfflineReady() {
      showOfflineReady();
    },
  });

  function showUpdate() {
    toast("Update available", {
      action: {
        label: "Reload",
        onClick: () => {
          // test seam: lets e2e assert the wiring without a real reload race
          const w = window as unknown as Record<string, unknown>;
          w.__pwaUpdateCalled = true;
          if (!w.__pwaNoReload) void updateSW(true);
        },
      },
    });
  }

  function showOfflineReady() {
    toast("Ready to work offline", { timeout: 4000 });
  }

  // Install affordance (Android / desktop Chrome fire beforeinstallprompt).
  let deferredPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as Event & { prompt: () => Promise<void> };
    toast("Install ball-stencil", {
      action: {
        label: "Install",
        onClick: () => {
          void deferredPrompt?.prompt();
          deferredPrompt = null;
        },
      },
      timeout: 12000,
    });
  });

  // iOS Safari never fires beforeinstallprompt; offer a one-time hint.
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (isIos && !standalone && !localStorage.getItem("ball-stencil:ios-hint")) {
    try { localStorage.setItem("ball-stencil:ios-hint", "1"); } catch { /* ignore */ }
    toast("Install: tap Share, then “Add to Home Screen”", { timeout: 8000 });
  }

  // Test seam: drive the real toast/update code paths deterministically.
  (window as unknown as Record<string, unknown>).__pwa = {
    needRefresh: showUpdate,
    offlineReady: showOfflineReady,
  };
}
