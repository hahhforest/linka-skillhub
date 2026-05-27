import { describe, expect, it } from "vitest";
import { agentColor } from "./skillVisuals.js";
import { OFFICIAL_AGENT_KINDS, OfficialLogo, OfficialLogoImage } from "./agentLogos.js";

// AgentLogo resolution order: OfficialLogoImage (PNG asset) → OfficialLogo
// (inline SVG) → deterministic-color avatar via agentColor. These tests pin
// each tier without rendering React.

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
    const left = agentColor("alpha-agent");
    const right = agentColor("zeta-agent");
    expect(left.background).not.toBe(right.background);
  });
});

describe("official logo registries", () => {
  it("every supported agent ships an image asset", () => {
    const expected = ["claude", "codex", "cursor", "mavis", "hermes", "openclaw", "opencode"];
    for (const kind of expected) {
      expect(OfficialLogoImage[kind], `OfficialLogoImage should expose '${kind}'`).toBeTypeOf("string");
      expect(OfficialLogoImage[kind]?.length ?? 0, `${kind} image URL should be non-empty`).toBeGreaterThan(0);
      expect(OFFICIAL_AGENT_KINDS).toContain(kind);
    }
  });

  it("OfficialLogo SVG map is empty — the project does not ship hand-drawn marks", () => {
    expect(Object.keys(OfficialLogo)).toEqual([]);
  });

  it("does not register a fallback for unknown agents", () => {
    expect(OfficialLogoImage["shared"]).toBeUndefined();
    expect(OfficialLogoImage["some-user-added-agent"]).toBeUndefined();
    expect(OfficialLogo["some-user-added-agent"]).toBeUndefined();
  });
});
