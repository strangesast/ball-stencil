/**
 * Overlay/sheet manager. The same DOM serves both layouts: on desktop a panel
 * is a non-modal floating frosted card that leaves the canvas interactive; on
 * small viewports it becomes a modal bottom-sheet with a dim backdrop, focus
 * trap, Escape / backdrop-tap / swipe-down to close, and focus restoration.
 *
 * Only one panel is open at a time (launcher-chip model). All inputs stay in
 * the DOM at all times — collapsing only flips visibility — so automation can
 * still reach controls inside a closed panel after opening it.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

export class Sheets {
  private chips = new Map<string, HTMLButtonElement>();
  private panels = new Map<string, HTMLElement>();
  private backdrop: HTMLElement;
  private mql = window.matchMedia("(max-width: 1024px)");
  private openName: string | null = null;
  private lastFocus: HTMLElement | null = null;
  private changeCb: ((name: string | null) => void) | null = null;

  constructor() {
    this.backdrop = document.getElementById("backdrop")!;
    for (const chip of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-panel]"))) {
      const name = chip.dataset.panel!;
      this.chips.set(name, chip);
      const panel = document.getElementById(`panel-${name}`);
      if (panel) this.panels.set(name, panel);
      chip.addEventListener("click", () => this.toggle(name));
    }
    for (const [name, panel] of this.panels) {
      for (const btn of Array.from(panel.querySelectorAll<HTMLButtonElement>(".sheet-close"))) {
        btn.addEventListener("click", () => this.close());
      }
      this.wireSwipeToClose(panel);
      void name;
    }
    this.backdrop.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.openName) {
        e.preventDefault();
        this.close();
      } else if (e.key === "Tab" && this.openName && this.isModal()) {
        this.trapTab(e);
      }
    });
    // Keep modality coherent if the viewport crosses the breakpoint while open.
    this.mql.addEventListener("change", () => {
      if (this.openName) this.applyModality(this.openName);
    });
  }

  onChange(cb: (name: string | null) => void) {
    this.changeCb = cb;
  }

  current() {
    return this.openName;
  }

  isModal() {
    return this.mql.matches;
  }

  toggle(name: string) {
    if (this.openName === name) this.close();
    else this.open(name);
  }

  open(name: string, opts: { silent?: boolean } = {}) {
    if (!this.panels.has(name)) return;
    if (this.openName && this.openName !== name) this.hide(this.openName);
    if (!this.openName) this.lastFocus = document.activeElement as HTMLElement | null;
    this.openName = name;
    const panel = this.panels.get(name)!;
    const chip = this.chips.get(name)!;
    panel.hidden = false;
    panel.classList.add("open");
    chip.setAttribute("aria-expanded", "true");
    chip.classList.add("active");
    this.applyModality(name);
    const body = panel.querySelector<HTMLElement>(".sheet-body");
    if (body) body.scrollTop = 0;
    // Focus the first control for keyboard users.
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    if (first && !opts.silent) first.focus();
    if (!opts.silent) this.changeCb?.(name);
  }

  close() {
    if (!this.openName) return;
    const name = this.openName;
    this.hide(name);
    this.openName = null;
    this.backdrop.hidden = true;
    document.body.classList.remove("sheet-modal-open");
    if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
    this.changeCb?.(null);
  }

  private hide(name: string) {
    const panel = this.panels.get(name)!;
    const chip = this.chips.get(name)!;
    panel.classList.remove("open");
    panel.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    chip.classList.remove("active");
  }

  private applyModality(name: string) {
    const panel = this.panels.get(name)!;
    const modal = this.isModal();
    panel.setAttribute("aria-modal", modal ? "true" : "false");
    this.backdrop.hidden = !modal;
    document.body.classList.toggle("sheet-modal-open", modal);
  }

  private trapTab(e: KeyboardEvent) {
    const panel = this.panels.get(this.openName!)!;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private wireSwipeToClose(panel: HTMLElement) {
    const head = panel.querySelector<HTMLElement>(".sheet-head");
    if (!head) return;
    let startY = 0;
    let dy = 0;
    let active = false;
    head.addEventListener(
      "touchstart",
      (e) => {
        if (!this.isModal()) return;
        active = true;
        startY = e.touches[0].clientY;
        dy = 0;
      },
      { passive: true },
    );
    head.addEventListener(
      "touchmove",
      (e) => {
        if (!active) return;
        dy = e.touches[0].clientY - startY;
        if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
      },
      { passive: true },
    );
    const end = () => {
      if (!active) return;
      active = false;
      panel.style.transform = "";
      if (dy > 70) this.close();
    };
    head.addEventListener("touchend", end);
    head.addEventListener("touchcancel", end);
  }
}
