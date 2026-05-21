import type { AgentKind, ReviewLanguage } from "./types.js";

export type WorkflowPhase =
  | "idle"
  | "scanning"
  | "scanReady"
  | "reviewerSelected"
  | "reviewing"
  | "reviewed"
  | "registryImporting"
  | "registryImported"
  | "distributionPlanning"
  | "distributionPlanned"
  | "distributionApplying"
  | "distributed"
  | "error";

export type WorkflowActionType =
  | "SCAN_START"
  | "SCAN_SUCCESS"
  | "REVIEWER_SELECT"
  | "REVIEW_RUN"
  | "REVIEW_SUCCESS"
  | "REGISTRY_IMPORT_START"
  | "REGISTRY_IMPORT_SUCCESS"
  | "DISTRIBUTION_PLAN_START"
  | "DISTRIBUTION_PLAN_SUCCESS"
  | "DISTRIBUTION_APPLY_START"
  | "DISTRIBUTION_APPLY_SUCCESS"
  | "LANGUAGE_SET"
  | "FAIL"
  | "RESET";

export type WorkflowAction =
  | { readonly type: "SCAN_START" }
  | { readonly type: "SCAN_SUCCESS"; readonly scannedCount?: number }
  | { readonly type: "REVIEWER_SELECT"; readonly reviewer: AgentKind | "rules" }
  | { readonly type: "REVIEW_RUN" }
  | { readonly type: "REVIEW_SUCCESS"; readonly reviewedCount?: number }
  | { readonly type: "REGISTRY_IMPORT_START" }
  | { readonly type: "REGISTRY_IMPORT_SUCCESS"; readonly importedCount?: number }
  | { readonly type: "DISTRIBUTION_PLAN_START" }
  | { readonly type: "DISTRIBUTION_PLAN_SUCCESS"; readonly planId: string }
  | { readonly type: "DISTRIBUTION_APPLY_START" }
  | { readonly type: "DISTRIBUTION_APPLY_SUCCESS"; readonly copiedCount?: number }
  | { readonly type: "LANGUAGE_SET"; readonly language: ReviewLanguage }
  | { readonly type: "FAIL"; readonly message: string }
  | { readonly type: "RESET" };

export interface WorkflowState {
  readonly phase: WorkflowPhase;
  readonly reviewLanguage: ReviewLanguage;
  readonly selectedReviewer?: AgentKind | "rules";
  readonly scannedCount?: number;
  readonly reviewedCount?: number;
  readonly importedCount?: number;
  readonly distributionPlanId?: string;
  readonly copiedCount?: number;
  readonly error?: WorkflowError;
}

export interface WorkflowError {
  readonly message: string;
  readonly failedAction: WorkflowActionType;
  readonly previousPhase: WorkflowPhase;
}

export interface TransitionResult {
  readonly ok: boolean;
  readonly state: WorkflowState;
  readonly error?: WorkflowError;
}

type TransitionRule = Partial<Record<WorkflowActionType, WorkflowPhase>>;

export const WORKFLOW_TRANSITION_TABLE: Readonly<Record<WorkflowPhase, TransitionRule>> = {
  idle: {
    SCAN_START: "scanning"
  },
  scanning: {
    SCAN_SUCCESS: "scanReady",
    FAIL: "error"
  },
  scanReady: {
    SCAN_START: "scanning",
    REVIEWER_SELECT: "reviewerSelected",
    REGISTRY_IMPORT_START: "registryImporting"
  },
  reviewerSelected: {
    REVIEWER_SELECT: "reviewerSelected",
    REVIEW_RUN: "reviewing"
  },
  reviewing: {
    REVIEW_SUCCESS: "reviewed",
    FAIL: "error"
  },
  reviewed: {
    REVIEWER_SELECT: "reviewerSelected",
    REGISTRY_IMPORT_START: "registryImporting"
  },
  registryImporting: {
    REGISTRY_IMPORT_SUCCESS: "registryImported",
    FAIL: "error"
  },
  registryImported: {
    SCAN_START: "scanning",
    REVIEWER_SELECT: "reviewerSelected",
    DISTRIBUTION_PLAN_START: "distributionPlanning"
  },
  distributionPlanning: {
    DISTRIBUTION_PLAN_SUCCESS: "distributionPlanned",
    FAIL: "error"
  },
  distributionPlanned: {
    DISTRIBUTION_PLAN_START: "distributionPlanning",
    DISTRIBUTION_APPLY_START: "distributionApplying"
  },
  distributionApplying: {
    DISTRIBUTION_APPLY_SUCCESS: "distributed",
    FAIL: "error"
  },
  distributed: {
    SCAN_START: "scanning",
    DISTRIBUTION_PLAN_START: "distributionPlanning"
  },
  error: {
    RESET: "idle"
  }
};

export const createInitialWorkflowState = (reviewLanguage: ReviewLanguage = "zh"): WorkflowState => ({
  phase: "idle",
  reviewLanguage
});

export const getAllowedActions = (state: WorkflowState): readonly WorkflowActionType[] => {
  const phaseActions = Object.keys(WORKFLOW_TRANSITION_TABLE[state.phase]) as WorkflowActionType[];
  return state.phase === "error" ? phaseActions : [...phaseActions, "LANGUAGE_SET"];
};

export const canTransition = (state: WorkflowState, action: WorkflowAction): boolean =>
  action.type === "LANGUAGE_SET" ? state.phase !== "error" : WORKFLOW_TRANSITION_TABLE[state.phase][action.type] !== undefined;

const invalidTransition = (state: WorkflowState, action: WorkflowAction): TransitionResult => {
  const error: WorkflowError = {
    message: `Action ${action.type} is not allowed while workflow is ${state.phase}.`,
    failedAction: action.type,
    previousPhase: state.phase
  };
  return {
    ok: false,
    state: {
      ...state,
      phase: "error",
      error
    },
    error
  };
};

const applyActionData = (state: WorkflowState, action: WorkflowAction): WorkflowState => {
  switch (action.type) {
    case "SCAN_START":
      return {
        phase: state.phase,
        reviewLanguage: state.reviewLanguage
      };
    case "SCAN_SUCCESS":
      return { ...state, scannedCount: action.scannedCount };
    case "REVIEWER_SELECT":
      return { ...state, selectedReviewer: action.reviewer };
    case "REVIEW_SUCCESS":
      return { ...state, reviewedCount: action.reviewedCount };
    case "REGISTRY_IMPORT_SUCCESS":
      return { ...state, importedCount: action.importedCount };
    case "DISTRIBUTION_PLAN_START":
      return { ...state, distributionPlanId: undefined, copiedCount: undefined };
    case "DISTRIBUTION_PLAN_SUCCESS":
      return { ...state, distributionPlanId: action.planId };
    case "DISTRIBUTION_APPLY_SUCCESS":
      return { ...state, copiedCount: action.copiedCount };
    case "LANGUAGE_SET":
      return { ...state, reviewLanguage: action.language };
    case "FAIL":
      return {
        ...state,
        error: {
          message: action.message,
          failedAction: action.type,
          previousPhase: state.phase
        }
      };
    case "RESET":
      return createInitialWorkflowState(state.reviewLanguage);
    case "REVIEW_RUN":
    case "REGISTRY_IMPORT_START":
    case "DISTRIBUTION_APPLY_START":
      return state;
  }
};

export const transitionWorkflow = (state: WorkflowState, action: WorkflowAction): TransitionResult => {
  if (!canTransition(state, action)) return invalidTransition(state, action);

  const nextPhase = action.type === "LANGUAGE_SET" ? state.phase : WORKFLOW_TRANSITION_TABLE[state.phase][action.type];
  const nextState = {
    ...applyActionData({ ...state, error: undefined }, action),
    phase: nextPhase ?? state.phase
  };
  return {
    ok: true,
    state: nextState
  };
};

export const workflowReducer = (state: WorkflowState = createInitialWorkflowState(), action: WorkflowAction): WorkflowState => transitionWorkflow(state, action).state;
