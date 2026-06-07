import { describe, expect, it } from "vitest";
import { resolveDistributionApplyPlan } from "../src/server.js";
import type { DistributionPlan } from "@linka-skillhub/core";

const buildPlan = (id = "plan-1"): DistributionPlan => ({
  id,
  createdAt: "2026-06-05T00:00:00.000Z",
  warnings: [],
  items: []
});

describe("resolveDistributionApplyPlan", () => {
  it("requires a confirm token from a prior server-side preview", () => {
    const result = resolveDistributionApplyPlan(undefined, () => buildPlan());
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { code: "confirmation_required" }
    });
  });

  it("rejects unknown or expired tokens instead of accepting a client-supplied plan fallback", () => {
    const result = resolveDistributionApplyPlan("forged-plan", () => undefined);
    expect(result).toMatchObject({
      ok: false,
      status: 410,
      body: { code: "plan_expired" }
    });
  });

  it("does not recompute or recover a missing plan from the request body", () => {
    let lookupCount = 0;
    const result = resolveDistributionApplyPlan("plan-from-client-body", () => {
      lookupCount += 1;
      return undefined;
    });
    expect(lookupCount).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      status: 410,
      body: { code: "plan_expired" }
    });
  });

  it("returns only plans found in the server cache", () => {
    const plan = buildPlan("cached-plan");
    const result = resolveDistributionApplyPlan("cached-plan", (id) => (id === plan.id ? plan : undefined));
    expect(result).toEqual({ ok: true, plan });
  });
});
