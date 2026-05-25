import { messages, type Language } from "./i18n.js";

const NETWORK_HINTS = ["Failed to fetch", "NetworkError", "Load failed"];

const codeOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
};

const messageOf = (error: unknown): string | undefined => {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return undefined;
};

/**
 * Convert an error from the API helper (or anywhere else) into a localized,
 * user-friendly footer string.
 *
 * - Wraps network failures (the request helper tags them with
 *   code="network_unreachable", but we also pattern-match on "Failed to fetch"
 *   / "NetworkError" / "Load failed" so direct fetch errors are handled too).
 * - Maps known server-side codes (confirmation_required, plan_expired,
 *   plan_id_mismatch) to localized strings.
 * - Falls back to the original error.message for any other error so callers
 *   keep the existing detail (e.g. "Cannot load registry: outside_profile_root").
 */
export function humanizeError(error: unknown, lang: Language): string {
  const t = messages[lang];
  if (error === null || error === undefined) return t.errorUnknown;

  const code = codeOf(error);
  const text = messageOf(error);

  if (code === "network_unreachable") return t.errorNetworkUnreachable;
  if (code === "confirmation_required") return t.errorConfirmationRequired;
  if (code === "plan_expired") return t.errorPlanExpired;
  if (code === "plan_id_mismatch") return t.errorPlanMismatch;

  if (text && NETWORK_HINTS.some((hint) => text.includes(hint))) {
    return t.errorNetworkUnreachable;
  }

  if (text) return text;
  return t.errorUnknown;
}
