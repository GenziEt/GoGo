import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Native-feeling UI primitives for the Telegram Mini App:
// - useMainButton: binds a React action to Telegram's own bottom MainButton (no "foreign website" CTA)
// - ConfirmSheet: replaces window.confirm() with an in-app sheet (Telegram can't render native dialogs reliably)
// - Toasts: upgraded with haptics + Telegram link colors
import React from "react";
import { haptic, isTelegram } from "./telegram.js";
export function useMainButton(spec) {
    const key = spec ? `${spec.text}|${spec.color}|${spec.textColor}` : "";
    const ref = React.useRef(spec);
    ref.current = spec;
    React.useEffect(() => {
        if (!key)
            return;
        const w = window.Telegram?.WebApp;
        const mb = w?.MainButton;
        if (!mb || !isTelegram())
            return;
        let disposed = false;
        const handler = () => { haptic("medium"); if (!disposed)
            ref.current?.onClick(); };
        // Keep the fixed bottom nav clear of the native MainButton (it overlays the viewport bottom).
        const clearance = () => {
            try {
                const r = mb.getViewportBottomOffset?.();
                document.documentElement.style.setProperty("--tg-main-clearance", typeof r === "number" ? `${r + 8}px` : "72px");
            }
            catch { /* noop */ }
        };
        try {
            mb.setText?.(ref.current?.text ?? "");
            mb.show?.();
            if (ref.current?.color)
                mb.setParams?.({ button_color: ref.current.color });
            else
                mb.setParams?.({}); // reset to theme accent
            mb.setOnClickHandler?.(handler);
            mb.enable?.();
            clearance();
        }
        catch { /* older SDK versions */ }
        window.addEventListener("resize", clearance);
        return () => {
            disposed = true;
            window.removeEventListener("resize", clearance);
            document.documentElement.style.removeProperty("--tg-main-clearance");
            try {
                mb.offClickHandler?.(handler);
                mb.hide?.();
            }
            catch { /* noop */ }
        };
    }, [key]);
}
export function ConfirmSheet({ title, body, confirmLabel, cancelLabel, danger, onConfirm, onCancel }) {
    React.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape")
            onCancel(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onCancel]);
    return (_jsx("div", { className: "sheet-overlay", onClick: onCancel, children: _jsxs("div", { className: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title, onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: title }), body && _jsx("p", { children: body }), _jsxs("div", { className: "sheet-actions", children: [_jsx("button", { className: "sheet-btn", onClick: onCancel, children: cancelLabel }), _jsx("button", { className: danger ? "sheet-btn sheet-danger" : "sheet-btn sheet-confirm", onClick: () => { haptic(danger ? "error" : "ok"); onConfirm(); }, children: confirmLabel })] })] }) }));
}
