// Inline-SVG agent marks. All four official agents below render via these
// components in <AgentLogo>. The viewbox is fixed at 24x24 so the marks line
// up with the lucide-react icons used elsewhere (sidebar nav, stat cards,
// action bar buttons); stroke widths stay at 1.5px for the same reason.
//
// The marks are deliberately simplified, recognizable silhouettes — they are
// NOT verbatim lifts of any brand wordmark. Each one is a 1-2 path geometric
// gesture meant to be readable at 16px next to an agent name, not a faithful
// reproduction of the upstream brand identity. Brand colors are widely
// published and used here as a single accent stroke/fill per mark.
//
// To add a new official agent: implement a 24x24 mark below and register it
// in the OfficialLogo map. Unknown agents (anything not in this map) fall
// through to the deterministic random-color avatar in skillVisuals.tsx.

import type { JSX } from "react";

// Anthropic / Claude Code — eight-point asterisk / starburst. Anthropic's
// public mark is a similar radial burst; here we draw four crossing lines
// at 45-degree intervals so the silhouette reads as "Claude" at a glance
// without copying the exact upstream geometry.
function ClaudeMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
      <line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
    </svg>
  );
}

// OpenAI / Codex — knot / flower silhouette. OpenAI's public mark is a six-
// fold rotational knot; we sketch a single circle + two crossed petals that
// keeps the same "woven" feel at small sizes without copying the upstream
// path data. Stroke uses OpenAI's near-black neutral.
function CodexMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#111827" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M5 10c5 0 9 4 14 4" />
      <path d="M5 14c5 0 9 -4 14 -4" />
    </svg>
  );
}

// OpenCode / SST — stylized "{ }" curly braces sitting on a code line. SST /
// OpenCode lean into a terminal aesthetic, and brace pairs read instantly as
// "shell/CLI" at icon size. SST cyan is used as the stroke.
function OpenCodeMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4c-2.5 0-3 1.6-3 3.5 0 2-1 3-2 4 1 1 2 2 2 4 0 1.9 .5 4.5 3 4.5" />
      <path d="M15 4c2.5 0 3 1.6 3 3.5 0 2 1 3 2 4-1 1-2 2-2 4 0 1.9-.5 4.5-3 4.5" />
    </svg>
  );
}

// Mavis / mavis — custom designed mark. Mavis is the user's own brand and
// does not have a published wordmark we can lean on, so this is intentional
// original design: a stylized "P" silhouette drawn as a single continuous
// loop with an inner counter dot, evoking a sealed envelope or a node-and-
// edge graph (Mavis is, at its heart, a graph of skills routed between
// agents). The primary brand blue keeps it visually anchored to SkillHub's
// own palette so the user's home agent does not feel like a competitor.
function PaeczMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V6a3 3 0 0 1 3-3h5a5 5 0 0 1 0 10H9" />
      <circle cx="11" cy="8" r="1.4" fill="#2563eb" stroke="none" />
    </svg>
  );
}

// Cursor (the editor) — stylized arrow / pointer mark. Cursor's own brand
// leans into a literal mouse-pointer silhouette; here we draw a single
// triangular pointer (the upper-left arrow) plus a small "click" dot to
// reinforce the click-cursor metaphor without copying their exact glyph.
// Indigo (#6366f1) is a close visual match for Cursor's dark blue-purple
// brand tint and is distinct from the four existing official agent colors
// (Anthropic orange, OpenAI near-black, SST cyan, Mavis blue) — see the
// FALLBACK_PALETTE comment in skillVisuals.tsx for the same "stay distinct"
// rule applied to the random-color avatar buckets.
function CursorMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4l10 6.5-4.5 1.2 2.6 6-2 .8-2.6-6L5 16z" />
      <circle cx="18" cy="18" r="1.2" fill="#6366f1" stroke="none" />
    </svg>
  );
}

// Registry of officially supported agents. AgentLogo checks for membership
// here before falling back to the random-color avatar. The key is the agent
// `kind` (matches @linka-skillhub/core's AgentKind).
export const OfficialLogo: Record<string, () => JSX.Element> = {
  claude: ClaudeMark,
  codex: CodexMark,
  opencode: OpenCodeMark,
  mavis: PaeczMark,
  cursor: CursorMark
};

// Set of agent kinds with an official logo. Exported separately so tests
// can pin the official-vs-fallback split without importing the JSX module.
export const OFFICIAL_AGENT_KINDS = Object.keys(OfficialLogo);
