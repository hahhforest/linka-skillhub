import { describe, expect, it } from "vitest";
import { agentColor } from "./skillVisuals.js";
import { OFFICIAL_AGENT_KINDS, OfficialLogo } from "./agentLogos.js";

// R35-C2: AgentLogo renders official agents via OfficialLogo (inline SVG) and
// unknown agents via a deterministic-color avatar. These tests pin the
// behaviour without rendering React — agentColor is a pure function and
// OFFICIAL_AGENT_KINDS is a plain string array, so vitest does not need a
// DOM environment.

describe("agentColor", () => {
  it("returns the same color for the same input across calls", () => {
    // Re-call with the same label and assert stability — the production code
    // relies on this so a row's chip doesn't reshuffle between reloads.
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

describe("OfficialLogo registry", () => {
  it("includes all 4 officially supported agents (claude, codex, opencode, mavis)", () => {
    const expected = ["claude", "codex", "opencode", "mavis"];
    for (const kind of expected) {
      expect(OfficialLogo[kind], `OfficialLogo should expose '${kind}'`).toBeTypeOf("function");
      expect(OFFICIAL_AGENT_KINDS).toContain(kind);
    }
  });

  it("does not register a fallback for unknown agents", () => {
    // The whole point of the agentColor fallback is that unknown agents skip
    // OfficialLogo entirely. If a future commit adds e.g. `shared` to the
    // map by accident, AgentLogo would stop using the random-color path.
    expect(OfficialLogo["shared"]).toBeUndefined();
    expect(OfficialLogo["some-user-added-agent"]).toBeUndefined();
  });
});
