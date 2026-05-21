import { describe, expect, it } from "vitest";
import { canTransition, createInitialWorkflowState, getAllowedActions, transitionWorkflow, workflowReducer } from "../src/workflow-state.js";

describe("workflow state machine", () => {
  it("runs legal scan, review, registry import, and distribution transitions", () => {
    let state = createInitialWorkflowState();

    state = workflowReducer(state, { type: "SCAN_START" });
    expect(state.phase).toBe("scanning");

    state = workflowReducer(state, { type: "SCAN_SUCCESS", scannedCount: 3 });
    expect(state).toMatchObject({ phase: "scanReady", scannedCount: 3 });

    state = workflowReducer(state, { type: "REVIEWER_SELECT", reviewer: "rules" });
    expect(state).toMatchObject({ phase: "reviewerSelected", selectedReviewer: "rules" });

    state = workflowReducer(state, { type: "REVIEW_RUN" });
    expect(state.phase).toBe("reviewing");

    state = workflowReducer(state, { type: "REVIEW_SUCCESS", reviewedCount: 2 });
    expect(state).toMatchObject({ phase: "reviewed", reviewedCount: 2 });

    state = workflowReducer(state, { type: "REGISTRY_IMPORT_START" });
    expect(state.phase).toBe("registryImporting");

    state = workflowReducer(state, { type: "REGISTRY_IMPORT_SUCCESS", importedCount: 2 });
    expect(state).toMatchObject({ phase: "registryImported", importedCount: 2 });

    state = workflowReducer(state, { type: "DISTRIBUTION_PLAN_START" });
    expect(state.phase).toBe("distributionPlanning");

    state = workflowReducer(state, { type: "DISTRIBUTION_PLAN_SUCCESS", planId: "plan-1" });
    expect(state).toMatchObject({ phase: "distributionPlanned", distributionPlanId: "plan-1" });

    state = workflowReducer(state, { type: "DISTRIBUTION_APPLY_START" });
    expect(state.phase).toBe("distributionApplying");

    state = workflowReducer(state, { type: "DISTRIBUTION_APPLY_SUCCESS", copiedCount: 2 });
    expect(state).toMatchObject({ phase: "distributed", copiedCount: 2 });
  });

  it("rejects illegal actions and records an error state", () => {
    const state = createInitialWorkflowState();
    const result = transitionWorkflow(state, { type: "REVIEW_RUN" });

    expect(result.ok).toBe(false);
    expect(result.state.phase).toBe("error");
    expect(result.error).toMatchObject({ failedAction: "REVIEW_RUN", previousPhase: "idle" });
    expect(canTransition(state, { type: "REVIEW_RUN" })).toBe(false);
  });

  it("enters an error state from failing in-progress work and can reset", () => {
    const scanning = workflowReducer(createInitialWorkflowState(), { type: "SCAN_START" });
    const failed = workflowReducer(scanning, { type: "FAIL", message: "scan failed" });

    expect(failed.phase).toBe("error");
    expect(failed.error).toMatchObject({ message: "scan failed", previousPhase: "scanning" });
    expect(getAllowedActions(failed)).toEqual(["RESET"]);

    const reset = workflowReducer(failed, { type: "RESET" });
    expect(reset).toEqual(createInitialWorkflowState());
  });

  it("requires distribution planning before apply", () => {
    const scanReady = workflowReducer(workflowReducer(createInitialWorkflowState(), { type: "SCAN_START" }), { type: "SCAN_SUCCESS" });
    const registryImported = workflowReducer(workflowReducer(scanReady, { type: "REGISTRY_IMPORT_START" }), { type: "REGISTRY_IMPORT_SUCCESS" });

    expect(canTransition(registryImported, { type: "DISTRIBUTION_APPLY_START" })).toBe(false);
    expect(workflowReducer(registryImported, { type: "DISTRIBUTION_APPLY_START" })).toMatchObject({
      phase: "error",
      error: { failedAction: "DISTRIBUTION_APPLY_START", previousPhase: "registryImported" }
    });

    const planned = workflowReducer(workflowReducer(registryImported, { type: "DISTRIBUTION_PLAN_START" }), {
      type: "DISTRIBUTION_PLAN_SUCCESS",
      planId: "plan-2"
    });
    expect(canTransition(planned, { type: "DISTRIBUTION_APPLY_START" })).toBe(true);
    expect(workflowReducer(planned, { type: "DISTRIBUTION_APPLY_START" }).phase).toBe("distributionApplying");
  });

  it("requires selecting a reviewer before running review", () => {
    const scanReady = workflowReducer(workflowReducer(createInitialWorkflowState(), { type: "SCAN_START" }), { type: "SCAN_SUCCESS" });

    expect(canTransition(scanReady, { type: "REVIEW_RUN" })).toBe(false);
    expect(workflowReducer(scanReady, { type: "REVIEW_RUN" })).toMatchObject({
      phase: "error",
      error: { failedAction: "REVIEW_RUN", previousPhase: "scanReady" }
    });

    const reviewerSelected = workflowReducer(scanReady, { type: "REVIEWER_SELECT", reviewer: "codex" });
    expect(canTransition(reviewerSelected, { type: "REVIEW_RUN" })).toBe(true);
    expect(workflowReducer(reviewerSelected, { type: "REVIEW_RUN" }).phase).toBe("reviewing");
  });

  it("updates reviewLanguage when language changes", () => {
    const state = workflowReducer(createInitialWorkflowState("zh"), { type: "LANGUAGE_SET", language: "en" });

    expect(state).toMatchObject({ phase: "idle", reviewLanguage: "en" });

    const scanReady = workflowReducer(workflowReducer(state, { type: "SCAN_START" }), { type: "SCAN_SUCCESS" });
    const changedAgain = workflowReducer(scanReady, { type: "LANGUAGE_SET", language: "zh" });
    expect(changedAgain).toMatchObject({ phase: "scanReady", reviewLanguage: "zh" });
  });
});
