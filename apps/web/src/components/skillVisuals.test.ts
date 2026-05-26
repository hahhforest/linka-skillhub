import { describe, expect, it } from "vitest";
import { agentColor } from "./skillVisuals.js";
import { OFFICIAL_AGENT_KINDS, OfficialLogo, OfficialLogoImage } from "./agentLogos.js";

// AgentLogo renders project-owned official agents via OfficialLogoImage (PNG
// assets — e.g. the user's own desktop app icon) or OfficialLogo (inline SVG
// marks the project itself owns). Anything else flows into the deterministic
// color avatar in agentColor. These tests pin that split without rendering
// React — agentColor is pure and the two registries are plain maps.

describe("agentColor", () => {
  it("returns the same color for the same input across calls", () => {
    const first = agentColor("my-custom-agent");
    const second = agentColor("my-custom-agent");
    expect(first.background).toBe(second.background);
    expect(first.foreground).toBe(second.foreground);
  });

  it("returns the same color again on a third invocation (sanity)", () => {
    const a = agentColor("hr-auto-sourcing");
    const b = agentColor("hr-auto-sourcing");
    const c = agentColor("hr-auto-sourcing");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("returns different colors for two distinct non-official agent labels", () => {
    // The palette has 10 entries, so two arbitrary distinct labels will MOST
    // of the time map to different buckets. The pair below was checked by
    // hand against the DJB2 modulo to land in different buckets — if anyone
    // changes the palette size or hash, this assertion is the early warning.
    const left = agentColor("alpha-agent");
    const right = agentColor("zeta-agent");
    expect(left.background).not.toBe(right.background);
  });
});

describe("official logo registries", () => {
  it("mavis is an image-backed official agent (user's own app icon)", () => {
    expect(OfficialLogoImage["mavis"], "OfficialLogoImage should expose 'mavis'").toBeTypeOf("string");
    expect(OfficialLogoImage["mavis"]?.length ?? 0, "mavis image URL should be non-empty").toBeGreaterThan(0);
    expect(OFFICIAL_AGENT_KINDS).toContain("mavis");
  });

  it("OfficialLogo SVG map is empty — third-party brand marks are NOT shipped inline", () => {
    // Project-owned inline SVGs only. Substituted brand glyphs for Claude /
    // Codex / OpenCode / Cursor go through the random-color avatar instead.
    expect(Object.keys(OfficialLogo)).toEqual([]);
  });

  it("does not register a fallback for unknown or third-party agents", () => {
    expect(OfficialLogo["shared"]).toBeUndefined();
    expect(OfficialLogo["claude"]).toBeUndefined();
    expect(OfficialLogo["codex"]).toBeUndefined();
    expect(OfficialLogo["opencode"]).toBeUndefined();
    expect(OfficialLogo["cursor"]).toBeUndefined();
    expect(OfficialLogo["some-user-added-agent"]).toBeUndefined();
    expect(OfficialLogoImage["claude"]).toBeUndefined();
    expect(OfficialLogoImage["some-user-added-agent"]).toBeUndefined();
  });
});
