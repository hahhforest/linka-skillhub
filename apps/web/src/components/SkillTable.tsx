import { useMemo } from "react";
import type { SkillPackage } from "@linka-skillhub/core";
import { messages, type Language } from "../i18n.js";
import { AgentLogo, agentTone, statusClass, statusLabel } from "./skillVisuals.js";

export interface SkillTableProps {
  readonly skills: SkillPackage[];
  readonly lang: Language;
  readonly focusedId: string | null;
  readonly onFocus: (id: string) => void;
  // When omitted, no checkbox column renders — the table is pure browse (used
  // by Overview today, by Repo's read-only state in the future). When present,
  // the table flips into "browse + select for action" mode (Intersect today).
  readonly selectedIds?: ReadonlySet<string>;
  readonly onToggleSelect?: (id: string) => void;
  // Shown in place of rows when `skills` is empty. Default falls back to the
  // generic "no matches" copy so callers usually omit it.
  readonly emptyText?: string;
}

// Single source of truth for the skill row list. Overview and Intersect both
// render this so a UI tweak (focused styling, agent-tag rules, status pill
// wording) only lives in one place. The "focused vs checked" split is the key
// difference from the pre-R34 SkillRow: focus is single-row inspection,
// checked is the multi-row action queue, and the two never share state.
export function SkillTable({ skills, lang, focusedId, onFocus, selectedIds, onToggleSelect, emptyText }: SkillTableProps): JSX.Element {
  const t = messages[lang];
  const labels = statusLabel(lang);
  const showCheckbox = !!selectedIds && !!onToggleSelect;
  // `duplicateNames` used to live in Overview. Moving it here keeps the
  // "show the agent tag only when two skills share a name" rule consistent
  // for every consumer — Intersect would have lost this disambiguation
  // otherwise, because each lane only shows one agent's skills (no dups in
  // theory) but registry-scope lists can still collide.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    const dups = new Set<string>();
    for (const [name, count] of counts) if (count >= 2) dups.add(name);
    return dups;
  }, [skills]);
  if (skills.length === 0) {
    return <div className="skill-table-empty muted-copy">{emptyText ?? t.noMatchTitle}</div>;
  }
  return (
    <div className={`skill-table scrollable-list${showCheckbox ? " with-check" : ""}`}>
      {skills.map((skill) => {
        const displayStatus = skill.status.includes("unsafe") || skill.status.includes("invalid")
          ? labels.invalid
          : skill.status.includes("agent_bound")
            ? labels.agent_bound
            : skill.status.includes("portable") && skill.status.includes("valid")
              ? labels.portable
              : labels.unreviewed;
        const agentName = agentTone[skill.source.agent]?.label ?? skill.source.agent;
        const isFocused = focusedId === skill.id;
        const isChecked = selectedIds?.has(skill.id) ?? false;
        const classes = ["skill-row"];
        if (isFocused) classes.push("focused");
        if (isChecked) classes.push("checked");
        return (
          <div
            key={skill.id}
            role="button"
            tabIndex={0}
            className={classes.join(" ")}
            onClick={() => onFocus(skill.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onFocus(skill.id);
              }
            }}
            title={t.selectionHint}
          >
            {showCheckbox && (
              <input
                type="checkbox"
                className="skill-row-check"
                checked={isChecked}
                onChange={() => { /* controlled by onClick below */ }}
                // stopPropagation: a checkbox click toggles selection only. We
                // do NOT also flip the row's focus, so the user can queue rows
                // without losing whatever skill they're currently inspecting.
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSelect?.(skill.id);
                }}
                aria-label={skill.name}
              />
            )}
            <AgentLogo agent={skill.source.agent} />
            <span className="skill-main">
              <span className="skill-title-line">
                <strong>{skill.name}</strong>
                {duplicateNames.has(skill.name) && <span className="agent-tag" title={agentName}>{agentName}</span>}
              </span>
              <small title={skill.description || t.noDescription}>{skill.description || t.noDescription}</small>
            </span>
            <span className={`status-pill ${statusClass(skill)}`}>{displayStatus}</span>
          </div>
        );
      })}
    </div>
  );
}
