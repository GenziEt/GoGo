const wa = () => window.Telegram?.WebApp;
function luminance(hex) {
    if (!hex)
        return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3;
}
export function isTelegram() {
    return !!wa();
}
function applyTheme(tp) {
    if (!tp)
        return;
    const root = document.documentElement;
    const set = (name, value) => {
        if (value && /^#[0-9a-f]{3,8}$/i.test(value))
            root.style.setProperty(name, value);
    };
    set("--tg-bg", tp.bg_color);
    set("--tg-text", tp.text_color);
    set("--tg-hint", tp.hint_color);
    set("--tg-link", tp.link_color);
    set("--tg-button", tp.button_color);
    set("--tg-button-text", tp.button_text_color);
    set("--tg-secondary", tp.secondary_bg_color);
    set("--tg-header", tp.header_bg_color);
    set("--tg-section", tp.section_bg_color);
    set("--tg-cell", tp.cell_bg_color);
    set("--tg-destructive", tp.destructive_text_color);
    const lum = luminance(tp.bg_color ?? tp.section_bg_color);
    if (lum !== null)
        root.dataset.theme = lum > 140 ? "light" : "dark";
    const w = wa();
    try {
        if (w?.setHeaderColor && (tp.header_bg_color || tp.bg_color))
            w.setHeaderColor(tp.header_bg_color ?? tp.bg_color);
        if (w?.setBackgroundColor && tp.bg_color)
            w.setBackgroundColor(tp.bg_color);
        if (w?.setBackgroundFill)
            w.setBackgroundFill(true);
    }
    catch {
        /* cosmetic only */
    }
}
export function haptic(kind = "light") {
    const h = wa()?.HapticFeedback;
    try {
        if (!h)
            return;
        if (kind === "ok")
            h.notificationOccurred?.("success");
        else if (kind === "error")
            h.notificationOccurred?.("error");
        else
            h.impactOccurred?.(kind);
    }
    catch {
        /* unsupported on some clients */
    }
}
let backHook = null;
let themeListenerAttached = false;
// Call once at boot (also safe to call repeatedly — listeners are deduped).
export function initTelegramChrome() {
    const w = wa();
    if (!w)
        return;
    try {
        w.ready();
        w.expand();
        applyTheme(w.themeParams);
        if (!themeListenerAttached) {
            themeListenerAttached = true;
            w.onEvent?.("themeChanged", () => applyTheme(w.themeParams));
        }
        // Native back arrow: detail screens register a hook; when none is set we clear
        // the app-level overlays (composer/modals) before Telegram closes the WebView.
        w.onEvent?.("backButtonClicked", () => {
            if (backHook)
                backHook();
            else if (typeof window.__genziClearOverlays === "function")
                window.__genziClearOverlays();
        });
        if (w.HeaderButton && !w.isHeaderButtonVisible?.()) {
            // no-op: we rely on BackButton, which Telegram renders automatically
        }
    }
    catch {
        /* never block boot for chrome issues */
    }
}
export function setBackHook(fn) {
    backHook = fn;
    const w = wa();
    try {
        if (fn)
            w?.showBackButton?.();
        else
            w?.hideBackButton?.();
    }
    catch {
        /* older clients without BackButton API just ignore */
    }
}
