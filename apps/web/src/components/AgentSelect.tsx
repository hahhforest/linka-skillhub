import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { AgentLogo } from "./skillVisuals.js";

export interface AgentSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface AgentSelectProps {
  readonly value: string;
  readonly options: readonly AgentSelectOption[];
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}

// R35-C11: drop-in replacement for the four HTML `<select>` sites that pick
// an agent (Overview header filter, Intersect from/to, RepoBrowser filter).
// Native <select> can't render an image next to each option, so the previous
// dropdowns showed text only while the rest of the UI (agent chips, source
// bars, target grid) used the AgentLogo PNG. This component closes the gap:
// the trigger button and every popover row render <AgentLogo agent={value}>
// in front of the label. The special value "all" intentionally skips the
// logo (it isn't an agent; the label "全部来源" / "All sources" carries
// enough meaning on its own).
//
// Keyboard support (WCAG 2.1.1 parity with the native <select> we replaced):
//   Tab → focus trigger
//   Space / Enter / ArrowDown / ArrowUp on trigger → open popover, focus the
//     currently-selected (or first enabled) option
//   ArrowDown / ArrowUp inside popover → move active option, skipping disabled
//   Home / End → jump to first / last enabled option
//   Enter → activate current option (same path as mouse click)
//   Esc → close popover, return focus to trigger
//   Click-outside → close popover (no focus return; the user is now
//     interacting with whatever they clicked into)
export function AgentSelect({ value, options, onChange, ariaLabel, className }: AgentSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const current = options.find((option) => option.value === value);

  const findEnabled = (start: number, step: 1 | -1): number => {
    if (options.length === 0) return -1;
    let idx = start;
    for (let i = 0; i < options.length; i += 1) {
      const candidate = (idx + options.length) % options.length;
      if (!options[candidate]?.disabled) return candidate;
      idx += step;
    }
    return -1;
  };

  const openWithFocus = (initial: number) => {
    setOpen(true);
    const enabled = findEnabled(initial >= 0 ? initial : 0, 1);
    setActiveIndex(enabled);
  };

  // Move DOM focus to the active option whenever the index changes while
  // open. Using the imperative ref instead of aria-activedescendant keeps
  // the focus ring visible (matches native <select> visual feedback).
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  const selectAndClose = (option: AgentSelectOption) => {
    if (option.disabled) return;
    // setOpen(false) MUST run before onChange. The parent's onChange
    // re-renders the popover with a new options array reference; if open
    // state hasn't already committed, the local setState gets lost in
    // reconciliation (popover ends up still open with aria-expanded=true).
    setOpen(false);
    triggerRef.current?.focus();
    onChange(option.value);
  };

  const handleTriggerKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      openWithFocus(selectedIndex >= 0 ? selectedIndex : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openWithFocus(selectedIndex >= 0 ? selectedIndex : options.length - 1);
    }
  };

  const handlePopoverKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      // Let Tab leave the dropdown naturally; close so focus moves cleanly
      // to the next focusable element on the page.
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => findEnabled(prev + 1, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => findEnabled((prev <= 0 ? options.length - 1 : prev - 1), -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(findEnabled(0, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(findEnabled(options.length - 1, -1));
    } else if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) selectAndClose(option);
    }
  };

  return (
    <div ref={wrapRef} className={`agent-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-select-button"
        onClick={() => {
          if (open) setOpen(false);
          else openWithFocus(options.findIndex((option) => option.value === value));
        }}
        onKeyDown={handleTriggerKey}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {value !== "all" && <AgentLogo agent={value} />}
        <span className="agent-select-label">{current?.label ?? value}</span>
        <ChevronDown size={14} className="agent-select-chevron" />
      </button>
      {open && (
        <ul
          className="agent-select-popover"
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={handlePopoverKey}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={`agent-select-option${option.value === value ? " selected" : ""}${option.disabled ? " disabled" : ""}${activeIndex === index ? " active" : ""}`}
              onClick={() => selectAndClose(option)}
              onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
            >
              {option.value !== "all" && <AgentLogo agent={option.value} />}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
