// Optional inline-SVG marks for agents whose brand is owned by the project
// itself. Officially supported third-party agents (Claude / Codex / OpenCode
// / Cursor) DO NOT get an inline mark here — rendering a substituted brand
// glyph for them, even hand-drawn, is the kind of brand-substitute pattern
// we deliberately avoid. They flow into the deterministic-color avatar in
// AgentLogo just like any user-added agent does.
//
// mavis is the user's own agent (Mavis). Their actual macOS app icon ships
// at apps/web/src/assets/agents/mavis.png and is loaded as an image asset.
// Adding a new image-backed agent: drop the file at the same path with a
// matching name and register it in OfficialLogoImage.
//
// AgentLogo (in skillVisuals.tsx) tries OfficialLogoImage first, then
// OfficialLogo (currently empty), then falls back to the deterministic
// random-color avatar.

import type { JSX } from "react";
import mavisLogoUrl from "../assets/agents/mavis.png";

// Reserved for future agents whose mark the project itself owns and ships
// inline. Empty by design — third-party agents do not appear here.
export const OfficialLogo: Record<string, () => JSX.Element> = {};

// Image-based official logos. Keyed by agent kind; the value is a Vite import
// URL the bundler turns into a hashed asset path.
export const OfficialLogoImage: Record<string, string> = {
  mavis: mavisLogoUrl
};

// Set of agent kinds that have any project-owned official logo (image OR
// svg). Exported separately so tests can pin the official-vs-fallback split
// without importing the JSX module.
export const OFFICIAL_AGENT_KINDS = [
  ...Object.keys(OfficialLogoImage),
  ...Object.keys(OfficialLogo)
];
