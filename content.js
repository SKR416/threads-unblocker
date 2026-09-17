/**
 * Threads Unblocker — Content Script (MAIN World)
 *
 * Multi-layer interception engine that enables browsing Threads
 * without logging in. Runs at document_start in the page's main
 * JavaScript context so it can override browser APIs.
 *
 * Layers:
 *   A) User-Agent spoofing  — trick SSR into serving full content
 *   B) Early CSS injection  — suppress modals before first paint
 *   C) MutationObserver     — continuously neutralise new modals & overlays
 *   D) Scroll-lock removal  — keep body/html/#scrollview scrollable
 *   E) SSR snapshot & restore — preserve server-rendered content
 */

(() => {
  "use strict";

  /* ──────────────────────────────────────────────────────────
   * Configuration
   * ────────────────────────────────────────────────────────── */
  const BOT_UA =
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; " +
    "Googlebot/2.1; +http://www.google.com/bot.html) " +
    "Chrome/128.0.0.0 Safari/537.36";

  // Set to true for console diagnostics
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log("[ThreadsUnblocker]", ...a);

  /* ──────────────────────────────────────────────────────────
   * Layer A — User-Agent Spoofing
   *
   * The HTTP-level UA is already changed by declarativeNetRequest
   * (rules.json). Here we align the in-page JS APIs so Threads'
   * client-side checks see the same Googlebot string.
   * ────────────────────────────────────────────────────────── */
  try {
    Object.defineProperty(navigator, "userAgent", {
      get: () => BOT_UA,
      configurable: true,
    });
  } catch (_) {
    log("navigator.userAgent spoof failed");
  }

  // Suppress User-Agent Client Hints (would leak real browser identity)
  try {
    if (navigator.userAgentData) {
      Object.defineProperty(navigator, "userAgentData", {
        get: () => undefined,
        configurable: true,
      });
    }
  } catch (_) {}

  /* ──────────────────────────────────────────────────────────
   * Layer B — Early CSS Injection
   *
   * blocker.css is injected via manifest, but as a safety net
   * we also inject critical rules inline so they survive even
   * if Threads removes <link> / <style> nodes.
   * ────────────────────────────────────────────────────────── */
  const CRITICAL_CSS = [
    // Hide login modals
    '[role="dialog"],[aria-modal="true"]{',
    "display:none!important;visibility:hidden!important;",
    "pointer-events:none!important;opacity:0!important}",
    // Unlock body/html scrolling
    "html,body{overflow:auto!important;overflow-y:auto!important;",
    "position:static!important;overscroll-behavior:auto!important;",
    "width:auto!important;top:auto!important}",
    // Unlock Threads' #scrollview container
    "#scrollview,div[scrollable]{overflow:auto!important;",
    "overflow-y:auto!important;max-height:none!important;",
    "height:auto!important;pointer-events:auto!important}",
    // Neutralise fixed overlays
    'div[style*="position: fixed"][style*="inset: 0"],',
    'div[style*="position:fixed"][style*="inset:0"],',
    'div[style*="position: fixed"][style*="inset: 0px"],',
    'div[style*="position:fixed"][style*="inset:0px"]',
    "{pointer-events:none!important}",
  ].join("");

  function ensureCSS() {
    if (document.getElementById("__tu")) return;
    const s = document.createElement("style");
    s.id = "__tu";
    s.textContent = CRITICAL_CSS;
    const target = document.head || document.documentElement;
    if (target) {
      target.insertBefore(s, target.firstChild);
      log("Inline CSS injected");
    }
  }

  // Try immediately (documentElement may already exist at document_start)
  if (document.documentElement) ensureCSS();

  // Retry when <head> becomes available
  document.addEventListener("DOMContentLoaded", ensureCSS, { once: true });

  /* ──────────────────────────────────────────────────────────
   * Layer C — MutationObserver: Modal & Overlay Neutralisation
   * ────────────────────────────────────────────────────────── */

  /**
   * Visually erase an element using inline !important styles.
   * Avoids DOM removal to prevent React Error Boundaries from firing.
   */
  function neutralise(el) {
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("opacity", "0", "important");
  }

  /**
   * Make an overlay transparent to pointer events without hiding it.
   * Used for backdrop layers that might have children we want to keep.
   */
  function passthrough(el) {
    el.style.setProperty("pointer-events", "none", "important");
  }

  /**
   * Walk up from a dialog element to find its portal / overlay
   * container and neutralise it. Limits walk to 4 ancestors to
   * avoid accidentally hiding the React root.
   */
  function neutralisePortal(dialogEl) {
    let el = dialogEl.parentElement;
    for (let depth = 0; depth < 4 && el; depth++) {
      if (el === document.body || el === document.documentElement) break;

      try {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "absolute") {
          neutralise(el);
          log("Portal container neutralised", el);
          return;
        }
      } catch (_) {}

      el = el.parentElement;
    }
  }

  /**
   * Detect full-screen fixed-position divs that act as dark
   * backdrops or invisible click-catchers behind modals.
   */
  function isFullScreenOverlay(el) {
    if (el.tagName !== "DIV") return false;
    // Skip elements that clearly hold page content
    if (el.querySelector("article, main, nav, header, footer")) return false;

    try {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed") return false;
      if (cs.display === "none" || cs.visibility === "hidden") return false;

      const r = el.getBoundingClientRect();
      const coversViewport =
        r.width >= window.innerWidth * 0.9 &&
        r.height >= window.innerHeight * 0.9;

      if (!coversViewport) return false;

      // It's an overlay if it wraps a dialog OR has a translucent bg
      const hasDialog = !!el.querySelector(
        '[role="dialog"],[aria-modal="true"]'
      );
      const bg = cs.backgroundColor;
      const isTranslucentBg =
        bg && bg.includes("rgba") && !bg.endsWith(", 0)");

      return hasDialog || isTranslucentBg;
    } catch (_) {
      return false;
    }
  }

  /**
   * Detect invisible "click-catcher" divs — fixed divs with no
   * visible content that sit on top of the page to block interaction.
   */
  function isClickCatcher(el) {
    if (el.tagName !== "DIV") return false;

    try {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") return false;

      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.8) return false;
      if (r.height < window.innerHeight * 0.8) return false;

      // If it has no text and no significant children, it's a click catcher
      const text = el.textContent.trim();
      if (text.length > 20) return false;

      // Check z-index — click catchers usually have high z-index
      const z = parseInt(cs.zIndex);
      if (isNaN(z) || z < 1) return false;

      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Process a newly-added DOM node: if it is (or contains) a
   * login dialog or overlay, neutralise it.
   */
  function processNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // Direct dialog/modal check
    const isDialog = node.matches?.('[role="dialog"], [aria-modal="true"]');
    if (isDialog) {
      neutralise(node);
      neutralisePortal(node);
      log("Dialog neutralised (direct)", node);
    }

    // Descendant match
    node
      .querySelectorAll?.('[role="dialog"], [aria-modal="true"]')
      .forEach((d) => {
        neutralise(d);
        neutralisePortal(d);
        log("Dialog neutralised (descendant)", d);
      });

    // Full-screen overlay detection
    if (isFullScreenOverlay(node)) {
      neutralise(node);
      log("Full-screen overlay neutralised", node);
    }

    // Invisible click-catcher detection
    if (isClickCatcher(node)) {
      passthrough(node);
      log("Click-catcher passthrough", node);
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Layer D — Scroll-Lock Removal
   *
   * Threads locks scrolling via THREE mechanisms:
   *   1. overflow:hidden on body/html
   *   2. position:fixed on body (pins viewport)
   *   3. overflow:hidden on #scrollview container
   * We must undo all three continuously.
   * ────────────────────────────────────────────────────────── */
  function unlockScroll() {
    const body = document.body;
    const html = document.documentElement;

    if (body) {
      body.style.setProperty("overflow", "auto", "important");
      body.style.setProperty("overflow-y", "auto", "important");
      body.style.setProperty("position", "static", "important");
      body.style.setProperty("width", "auto", "important");
      body.style.setProperty("top", "auto", "important");
      body.style.setProperty("touch-action", "auto", "important");
    }
    if (html) {
      html.style.setProperty("overflow", "auto", "important");
      html.style.setProperty("overflow-y", "auto", "important");
    }

    // Unlock Threads' internal scroll container
    const scrollview = document.getElementById("scrollview");
    if (scrollview) {
      scrollview.style.setProperty("overflow", "auto", "important");
      scrollview.style.setProperty("overflow-y", "auto", "important");
      scrollview.style.setProperty("max-height", "none", "important");
      scrollview.style.setProperty("height", "auto", "important");
      scrollview.style.setProperty("pointer-events", "auto", "important");
    }

    // Also find any div[scrollable] containers
    document.querySelectorAll('div[scrollable="true"]').forEach((el) => {
      el.style.setProperty("overflow", "auto", "important");
      el.style.setProperty("overflow-y", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
      el.style.setProperty("pointer-events", "auto", "important");
    });
  }

  /**
   * Sweep the entire page for any remaining fixed-position
   * overlays and click-catchers that might have slipped through.
   */
  function sweepOverlays() {
    // Check body's direct children for overlays
    if (document.body) {
      for (const child of document.body.children) {
        if (isFullScreenOverlay(child)) {
          neutralise(child);
          log("Sweep: overlay neutralised", child);
        } else if (isClickCatcher(child)) {
          passthrough(child);
          log("Sweep: click-catcher passthrough", child);
        }
      }
    }

    // Also check for any fixed-position divs across the page
    document
      .querySelectorAll('[role="dialog"], [aria-modal="true"]')
      .forEach((d) => {
        neutralise(d);
        neutralisePortal(d);
      });
  }

  /* ──────────────────────────────────────────────────────────
   * Layer E — SSR Snapshot & Content Restoration
   *
   * Because the HTTP UA is Googlebot, the SSR HTML includes
   * full post/article content. We deep-clone it before React
   * hydration can destroy it. If React later replaces the
   * content with an error view, we swap the snapshot back in.
   * ────────────────────────────────────────────────────────── */
  let snapshot = null;
  let snapshotTarget = null;
  let isRestored = false;

  /** Find the primary content element */
  function findContentRoot() {
    const candidates = [
      "main",
      '[role="main"]',
      "article",
      '[data-testid="thread-detail"]',
      '[data-testid="post-container"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 80) return el;
    }
    return null;
  }

  /** Take a deep-clone snapshot of the content root */
  function captureSnapshot() {
    if (snapshot) return; // Already captured
    const root = findContentRoot();
    if (!root) return;

    snapshot = root.cloneNode(true);
    snapshotTarget = root;
    log("SSR snapshot captured —", root.innerHTML.length, "chars");
  }

  /** Restore snapshot if the live content was destroyed */
  function restoreIfNeeded() {
    if (isRestored || !snapshot || !snapshotTarget) return;

    // Check for signs of content destruction
    const liveText = snapshotTarget.textContent.toLowerCase();
    const seemsDestroyed =
      snapshotTarget.innerHTML.length < 60 ||
      liveText.includes("error") ||
      liveText.includes("went wrong") ||
      liveText.includes("錯誤") ||
      liveText.includes("再試一次") ||
      liveText.includes("出了什麼問題") ||
      liveText.includes("暫時無法使用");

    if (!seemsDestroyed) return;

    log("Content appears destroyed — restoring from snapshot");

    const wrapper = document.createElement("div");
    wrapper.id = "tu-restored-content";
    wrapper.style.cssText =
      "pointer-events:auto!important;overflow:visible!important;";
    wrapper.appendChild(snapshot.cloneNode(true));

    snapshotTarget.parentNode?.insertBefore(
      wrapper,
      snapshotTarget.nextSibling
    );
    snapshotTarget.style.setProperty("display", "none", "important");
    isRestored = true;
    log("Content restored successfully");
  }

  /* ──────────────────────────────────────────────────────────
   * Bootstrap — Start all monitoring layers once DOM is parsed
   * ────────────────────────────────────────────────────────── */
  function boot() {
    log("Booting…");

    ensureCSS();
    unlockScroll();

    // ── SSR snapshot: capture at multiple points to maximise
    //    the chance of getting content before React hydrates ──
    captureSnapshot();
    setTimeout(captureSnapshot, 500);
    setTimeout(captureSnapshot, 1500);
    setTimeout(captureSnapshot, 3000);
    setTimeout(captureSnapshot, 6000);

    // ── Primary MutationObserver on the whole document ──
    const mainObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          processNode(node);
        }
      }
      unlockScroll();
      ensureCSS();
      if (!snapshot) captureSnapshot();
      if (snapshot && !isRestored) restoreIfNeeded();
    });

    mainObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // ── Body/html style observer: instantly undo scroll lock ──
    function watchElementStyle(el) {
      if (!el) return;
      const obs = new MutationObserver(() => unlockScroll());
      obs.observe(el, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }

    function initStyleWatchers() {
      if (!document.body) {
        setTimeout(initStyleWatchers, 50);
        return;
      }
      watchElementStyle(document.body);
      watchElementStyle(document.documentElement);

      // Watch #scrollview once it exists
      const sv = document.getElementById("scrollview");
      if (sv) {
        watchElementStyle(sv);
      } else {
        // Wait for it
        const svObs = new MutationObserver(() => {
          const s = document.getElementById("scrollview");
          if (s) {
            watchElementStyle(s);
            svObs.disconnect();
          }
        });
        svObs.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }

      unlockScroll();
    }
    initStyleWatchers();

    // ── Periodic health-check (fallback) ──
    let ticks = 0;
    const interval = setInterval(() => {
      ensureCSS();
      unlockScroll();
      sweepOverlays();

      captureSnapshot();
      if (snapshot && !isRestored) restoreIfNeeded();

      if (++ticks >= 120) {
        clearInterval(interval); // Stop after 60 s
        log("Periodic check stopped (60 s elapsed)");
      }
    }, 500);

    log("All layers active");
  }

  // Kick off as soon as the DOM is parsed
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();