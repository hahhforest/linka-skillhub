import { useEffect, useMemo, useRef, useState } from "react";
import { GitMerge, Loader2, X } from "lucide-react";
import type { CanonicalSyncStatus, SkillPackage, SyncMergeResult } from "@linka-skillhub/core";
import { api, type ReviewerInfo } from "../api.js";
import { humanizeError } from "../humanize-error.js";
import { messages, type Language } from "../i18n.js";
import { AgentLogo, agentTone } from "./skillVisuals.js";
import { useModalFocusTrap } from "./useModalFocusTrap.js";

export interface MergeDialogProps {
  readonly lang: Language;
  readonly skill: SkillPackage;
  readonly sync: CanonicalSyncStatus;
  readonly onMerged: (result: SyncMergeResult) => void;
  readonly onClose: () => void;
}

// issue #2: a single log line in the live agent-output panel. `text` is
// already the decoded chunk (could be multi-line), `kind` colors stderr
// dim. We keep them as discrete events instead of joining into one string
// so React re-renders are cheap (append a row instead of replace the whole
// blob).
interface LogChunk {
  readonly kind: "stdout" | "stderr";
  readonly text: string;
}

// R36-C22: dialog for the merge subsystem. Two phases:
//   1. picking — user multi-selects source instances (must be ≥2) and a
//      single executor agent. Submit triggers the long-running api.syncMerge.
//   2. working — dialog stays open showing a spinner + workspace path; close
//      button is disabled. We never auto-close on success because the
//      drift summary in mergeDoneSuccess is the user's only confirmation
//      that anything actually happened.
//
// reviewers are fetched once on open (same source as the Repo review dialog).
// Filtering: drop "rules" (it does no LLM work) and unavailable ones (their
// binary isn't on PATH so spawning would fail).
export function MergeDialog({ lang, skill, sync, onMerged, onClose }: MergeDialogProps): JSX.Element {
  const t = messages[lang];
  const [selectedFrom, setSelectedFrom] = useState<ReadonlySet<string>>(() => {
    // Pre-select every drifted instance — the typical merge target. The user
    // can uncheck or add in-sync rows if they want; the dialog enforces ≥2
    // before allowing submit.
    return new Set(sync.instances.filter((entry) => entry.status === "drifted").map((entry) => entry.realPath));
  });
  const [reviewers, setReviewers] = useState<ReviewerInfo[] | null>(null);
  const [byAgent, setByAgent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // issue #2: live agent output. Append-only during a run; cleared at the
  // start of each new submit (including retries triggered by the user
  // re-pressing Start after a failure). Bounded growth isn't enforced —
  // claude / codex CLI outputs aren't massive (a few MB at worst), and
  // truncating mid-stream would hide diagnostic info exactly when users
  // need it most.
  const [logChunks, setLogChunks] = useState<readonly LogChunk[]>([]);
  const logPanelRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, busy]);
  useEffect(() => {
    let cancelled = false;
    api.reviewers()
      .then((result) => { if (!cancelled) setReviewers(result.reviewers); })
      .catch(() => { if (!cancelled) setReviewers([]); });
    return () => { cancelled = true; };
  }, []);
  // Auto-scroll the log panel to the bottom whenever a new chunk lands —
  // but only if the user hasn't scrolled up to read older output. The
  // 20px threshold absorbs sub-pixel scroll position drift from React's
  // re-render.
  useEffect(() => {
    const panel = logPanelRef.current;
    if (!panel) return;
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 20;
    if (atBottom) panel.scrollTop = panel.scrollHeight;
  }, [logChunks]);
  // Cancel any in-flight stream when the dialog unmounts (parent closes us
  // mid-merge). Without this, the fetch keeps draining server output into a
  // dead component until the agent exits.
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const availableReviewers = useMemo(
    () => (reviewers ?? []).filter((reviewer) => reviewer.kind !== "rules" && reviewer.available),
    [reviewers]
  );

  // Pick a sensible default executor: first available reviewer in the order
  // claude > codex > opencode > mavis. Recompute when the reviewer list
  // resolves so the dropdown isn't blank on first paint.
  useEffect(() => {
    if (byAgent || availableReviewers.length === 0) return;
    const priority = ["claude", "codex", "opencode", "mavis"];
    const picked = priority.map((kind) => availableReviewers.find((r) => r.kind === kind)?.kind).find((kind) => !!kind);
    setByAgent(picked ?? availableReviewers[0]!.kind);
  }, [availableReviewers, byAgent]);

  const toggleFrom = (realPath: string) => {
    setSelectedFrom((current) => {
      const next = new Set(current);
      if (next.has(realPath)) next.delete(realPath);
      else next.add(realPath);
      return next;
    });
  };

  const fromAgentsForSubmit = useMemo(() => {
    // We collect the chosen instances' first viaAgent. The CLI / server side
    // resolves agent → instance via the same lookup, so picking *any* one of
    // the agents that reach the realPath is fine. We dedupe to handle the
    // edge case where the same realPath is reached via multiple agents.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const instance of sync.instances) {
      if (!selectedFrom.has(instance.realPath)) continue;
      const agent = instance.viaAgents[0];
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      out.push(agent);
    }
    return out;
  }, [sync.instances, selectedFrom]);

  // Surface the collision case: the user checked ≥2 rows but their first
  // viaAgents collapse to <2 distinct agents. Without an inline reason the
  // Start button would just sit disabled with no explanation.
  const collisionAgent = useMemo(() => {
    if (selectedFrom.size < 2 || fromAgentsForSubmit.length >= 2) return null;
    const counts = new Map<string, number>();
    for (const instance of sync.instances) {
      if (!selectedFrom.has(instance.realPath)) continue;
      const agent = instance.viaAgents[0];
      if (!agent) continue;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
    for (const [agent, count] of counts) {
      if (count >= 2) return agent;
    }
    return null;
  }, [sync.instances, selectedFrom, fromAgentsForSubmit.length]);

  const canSubmit = fromAgentsForSubmit.length >= 2 && byAgent.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setLogChunks([]); // clear log on each fresh submit (incl. retries from a prior error)
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await api.syncMergeStream(
        skill.name,
        fromAgentsForSubmit,
        byAgent,
        (kind, data) => {
          // Use functional setState because chunks arrive faster than React
          // can rerender; the closure-captured `logChunks` would be stale.
          setLogChunks((prev) => [...prev, { kind, text: data }]);
        },
        { signal: controller.signal }
      );
      onMerged(result);
    } catch (err) {
      // Suppress abort errors — those mean the user closed the dialog or
      // hit cancel intentionally, no need to scream about it.
      if (controller.signal.aborted) return;
      setError(`${t.mergeFailedTitle}: ${humanizeError(err, lang)}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-dialog-title"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog merge-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close" onClick={onClose} aria-label={t.cancel} disabled={busy}><X size={16} /></button>
        <h2 id="merge-dialog-title">{t.mergeDialogTitle.replace("{name}", skill.name)}</h2>
        {!busy && <p className="muted-copy">{t.mergeDialogBody}</p>}

        {busy && (
          <div className="merge-progress">
            <Loader2 className="spin" size={24} />
            <p className="merge-progress-title">
              {t.mergeWorkingTitle.replace("{name}", skill.name)}
            </p>
            <p className="muted-copy">
              {t.mergeWorkingBody.replace("{agent}", agentTone[byAgent]?.label ?? byAgent)}
            </p>
            {/* issue #2: live agent output panel. Always rendered while
                merging (even when empty) so the user has a stable spot to
                watch — text begins to appear as soon as the agent CLI
                writes its first chunk. The pre block scrolls horizontally
                for long lines (no wrap), vertically for many lines, with
                auto-stick-to-bottom handled in the effect above. */}
            <div className="merge-log-frame">
              <div className="merge-log-head">{t.mergeLogLabel}</div>
              <pre className="merge-log" ref={logPanelRef}>
                {logChunks.length === 0
                  ? <span className="merge-log-waiting">{t.mergeLogWaiting}</span>
                  : logChunks.map((chunk, index) => (
                      <span key={index} className={chunk.kind === "stderr" ? "merge-log-stderr" : "merge-log-stdout"}>
                        {chunk.text}
                      </span>
                    ))}
              </pre>
            </div>
          </div>
        )}

        {!busy && (
          <>
            <div className="merge-section">
              <h3>{t.mergeFromLabel}</h3>
              <p className="muted-copy">{t.mergeFromHint}</p>
              <ul className="merge-instance-list">
                {sync.instances.map((instance) => {
                  const checked = selectedFrom.has(instance.realPath);
                  const statusLabel =
                    instance.status === "in-sync" ? t.instanceStatusInSync :
                    instance.status === "drifted" ? t.instanceStatusDrifted :
                    t.instanceStatusMissing;
                  return (
                    <li key={instance.realPath} className={`merge-instance-row instance-status-${instance.status}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFrom(instance.realPath)}
                          disabled={instance.status === "missing"}
                        />
                        <span className={`instance-badge instance-badge-${instance.status}`}>{statusLabel}</span>
                        <span className="merge-instance-agents">
                          {instance.viaAgents.map((agent) => (
                            <AgentLogo key={agent} agent={agent} />
                          ))}
                        </span>
                        <code className="merge-instance-path">{instance.realPath}</code>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {collisionAgent && (
                <p className="danger-line merge-collision-warning">
                  {t.mergeAgentCollision.replace("{agent}", agentTone[collisionAgent]?.label ?? collisionAgent)}
                </p>
              )}
            </div>

            <div className="merge-section">
              <h3>{t.mergeByLabel}</h3>
              <p className="muted-copy">{t.mergeByHint}</p>
              {reviewers === null && <p className="muted-copy">{t.historyLoading}</p>}
              {reviewers !== null && availableReviewers.length === 0 && (
                <p className="danger-line">{t.mergeByReviewerNoneAvailable}</p>
              )}
              {availableReviewers.length > 0 && (
                <select
                  className="merge-by-select"
                  value={byAgent}
                  onChange={(event) => setByAgent(event.target.value)}
                >
                  {availableReviewers.map((reviewer) => (
                    <option key={reviewer.kind} value={reviewer.kind}>
                      {agentTone[reviewer.kind]?.label ?? reviewer.label} ({reviewer.kind})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {error ? <p className="danger-line">{error}</p> : null}
          </>
        )}

        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>{t.cancel}</button>
          <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2 className="spin" size={16} /> : <GitMerge size={16} />} {t.mergeStartButton}
          </button>
        </div>
      </div>
    </div>
  );
}
