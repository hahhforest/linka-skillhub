// Optional inline-SVG marks for agents whose brand is owned by the project
// itself. Currently empty — every officially supported agent ships a PNG
// asset via OfficialLogoImage below. The map is kept as the seam for future
// agents whose mark the project (not a third party) would author inline.
//
// All agent logo files live at apps/web/src/assets/agents/<kind>.png. Adding
// a new image-backed agent: drop the file at that path with a matching name
// and register it in OfficialLogoImage.
//
// AgentLogo (in skillVisuals.tsx) tries OfficialLogoImage first, then
// OfficialLogo, then falls back to the deterministic random-color avatar.

import type { JSX } from "react";
import claudeLogoUrl from "../assets/agents/claude.png";
import codexLogoUrl from "../assets/agents/codex.png";
import cursorLogoUrl from "../assets/agents/cursor.png";
import mavisLogoUrl from "../assets/agents/mavis.png";
import hermesLogoUrl from "../assets/agents/hermes.png";
import openclawLogoUrl from "../assets/agents/openclaw.png";
import opencodeLogoUrl from "../assets/agents/opencode.png";

// Reserved for future agents whose mark the project itself owns and ships
// inline. Empty by design — every current agent uses an image asset above.
export const OfficialLogo: Record<string, () => JSX.Element> = {};

// Image-based official logos. Keyed by agent kind; the value is a Vite import
// URL the bundler turns into a hashed asset path. Asset files are project-
// repository inputs supplied by the project owner; see apps/web/src/assets/
// agents/ for the actual files.
export const OfficialLogoImage: Record<string, string> = {
  claude: claudeLogoUrl,
  codex: codexLogoUrl,
  cursor: cursorLogoUrl,
  mavis: mavisLogoUrl,
  hermes: hermesLogoUrl,
  openclaw: openclawLogoUrl,
  opencode: opencodeLogoUrl
};

// Set of agent kinds that have any project-owned official logo (image OR
// svg). Exported separately so tests can pin the official-vs-fallback split
// without importing the JSX module.
export const OFFICIAL_AGENT_KINDS = [
  ...Object.keys(OfficialLogoImage),
  ...Object.keys(OfficialLogo)
];
