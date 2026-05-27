import { describe, expect, it } from "vitest";
import { parseCommitSubject } from "../src/history.js";

describe("parseCommitSubject", () => {
  it("recognises an import subject", () => {
    expect(parseCommitSubject("import lark-mail (origin: mavis)")).toEqual({
      action: "import",
      agents: ["mavis"]
    });
  });

  it("recognises a pull subject", () => {
    expect(parseCommitSubject("pull lark-mail (from claude)")).toEqual({
      action: "pull",
      agents: ["claude"]
    });
  });

  it("splits a merge subject into multiple agents", () => {
    expect(parseCommitSubject("merge lark-mail (mavis + claude + codex)")).toEqual({
      action: "merge",
      agents: ["mavis", "claude", "codex"]
    });
  });

  it("captures the via-agent in a fork subject", () => {
    expect(parseCommitSubject("fork lark-mail-v2 (from lark-mail, via claude)")).toEqual({
      action: "fork",
      agents: ["claude"]
    });
  });

  it("falls back to action='other' for unknown subject shapes", () => {
    expect(parseCommitSubject("chore: bump frontmatter version")).toEqual({
      action: "other",
      agents: []
    });
  });

  it("falls back to 'other' for our-prefixed but malformed subjects", () => {
    expect(parseCommitSubject("import lark-mail")).toEqual({ action: "other", agents: [] });
    expect(parseCommitSubject("merge lark-mail mavis claude")).toEqual({ action: "other", agents: [] });
  });
});
