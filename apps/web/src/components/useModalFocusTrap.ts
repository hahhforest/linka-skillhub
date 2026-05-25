import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Trap focus inside a modal dialog while it is open.
 *
 * - Saves the element that was focused before the modal mounted and restores
 *   it on unmount (so closing the dialog returns focus to the trigger).
 * - Moves focus into the dialog after mount, preferring the first focusable
 *   element that is NOT the `.dialog-close` button (so e.g. the primary
 *   action gets focus first). Falls back to the first focusable, then to
 *   the dialog container itself when nothing inside can be focused.
 * - Cycles Tab / Shift+Tab between the first and last focusable element so
 *   keyboard users cannot tab out of the dialog into background content.
 */
export function useModalFocusTrap(dialogRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const getFocusable = (): HTMLElement[] => {
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      return nodes.filter((node) => {
        if (node.hasAttribute("disabled")) return false;
        if (node.getAttribute("aria-hidden") === "true") return false;
        return true;
      });
    };

    const focusables = getFocusable();
    // Prefer the primary action button if present (e.g. "确认写入" on the
    // ConfirmPlanModal). Otherwise pick the first focusable that is not the
    // close (X) button. Falls back to the dialog container (tabIndex={-1}).
    const primary = focusables.find((node) => node.classList.contains("primary"));
    const initial = primary ?? focusables.find((node) => !node.classList.contains("dialog-close")) ?? focusables[0];
    if (initial) {
      initial.focus();
    } else {
      // Container fallback — relies on the caller setting tabIndex={-1} on the dialog node.
      dialog.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const current = getFocusable();
      if (current.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (!active || active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);

    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        // Browser already does this for ESC in many cases, but we also cover
        // backdrop-click and primary-action close paths.
        previouslyFocused.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
