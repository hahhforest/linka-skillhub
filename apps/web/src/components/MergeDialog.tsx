import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, GitMerge, Loader2, RotateCcw, Square, X } from "lucide-react";
import type { CanonicalSyncStatus, SkillPackage, SyncMergeResult, SyncPushResult } from "@linka-skillhub/core";
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

// Issue #2 follow-up: a single rendered line in the live agent-output panel.
// `summary` is a human-readable one-liner (parsed from claude stream-json or
// taken verbatim from text-mode runners); `rawJson` is the original JSON event
// when present, exposed via the per-line "show raw" expander. `kind` colors
// stderr distinctly; `level` lets us highlight tool calls vs. plain output.
type LogLevel = "info" | "system" | "tool" | "agent" | "stderr" | "raw";
interface LogLine {
  readonly kind: "stdout" | "stderr";
  readonly level: LogLevel;
  readonly summary: string;
  readonly rawJson?: string;
}

// Phase machine — the dialog is one of:
//   picking  — user chooses sources + executor; submit kicks off the merge
//   working  — agent CLI streaming live output; user can abort
//   done     — merge succeeded; show summary + push-all CTA before closing
//   error    — merge failed; show error + log + retry/close
// Auto-closing on success was the v1 behaviour and turned out to bury the
// drift-fan-out story. The done phase is the user's only natural moment to
// understand "yes the canonical is updated, no your sources aren't yet."
type Phase = "picking" | "working" | "done" | "error";

// Best-effort parser for claude stream-json. Each event is one JSON object on
// one line. We pull out a short human summary per recognised type, fall back
// to the raw line for anything we don't know about so nothing is silently
// dropped. text-mode runners (codex / opencode / mavis) emit plain text; we
// detect that and pass the line through verbatim.
const parseClaudeEvent = (line: string): LogLine | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (!type) return null;
  const rawJson = trimmed;
  if (type === "system") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (subtype === "init") {
      const model = typeof event.model === "string" ? event.model : "agent";
      return { kind: "stdout", level: "system", summary: `▶ session started (${model})`, rawJson };
    }
    return { kind: "stdout", level: "system", summary: `· system: ${subtype || "?"}`, rawJson };
  }
  // assistant events are handled by parseClaudeEventAll (it fans blocks out).
  if (type === "user") {
    // tool_result events come back as user-typed; surface as a "result" line.
    return { kind: "stdout", level: "tool", summary: "✓ tool result", rawJson };
  }
  if (type === "result") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    return { kind: "stdout", level: "system", summary: `■ result: ${subtype || "complete"}`, rawJson };
  }
  return { kind: "stdout", level: "raw", summary: `· ${type}`, rawJson };
};

// Multi-block assistant events produce multiple human lines (e.g. one
// tool_use plus one text in the same event). The single-event parser above
// returns the first; this fans out the rest so the panel shows every block.
const parseClaudeEventAll = (line: string): readonly LogLine[] => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (event.type !== "assistant") {
    const single = parseClaudeEvent(line);
    return single ? [single] : [];
  }
  const message = event.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const lines: LogLine[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockType = (block as { type?: unknown }).type;
    if (blockType === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) {
        const oneLine = text.replace(/\s+/g, " ").trim();
        const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
        lines.push({ kind: "stdout", level: "agent", summary: `🗣 ${clipped}`, rawJson: trimmed });
      }
    } else if (blockType === "tool_use") {
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input as Record<string, unknown> | undefined;
      const detail =
        (input?.file_path as string | undefined) ??
        (input?.path as string | undefined) ??
        (input?.pattern as string | undefined) ??
        (input?.command as string | undefined) ??
        "";
      const detailStr = detail.length > 80 ? `${detail.slice(0, 80)}…` : detail;
      lines.push({
        kind: "stdout",
        level: "tool",
        summary: detailStr ? `🔧 ${name ?? "tool"}: ${detailStr}` : `🔧 ${name ?? "tool"}`,
        rawJson: trimmed
      });
    }
  }
  if (lines.length === 0) {
    lines.push({ kind: "stdout", level: "agent", summary: "🗣 (assistant turn)", rawJson: trimmed });
  }
  return lines;
};

const chunkToLines = (kind: "stdout" | "stderr", data: string): readonly LogLine[] => {
  // stderr is rare — pass through as-is, no JSON parse attempt. agent CLIs
  // emit progress / warnings on stderr, never JSON.
  if (kind === "stderr") {
    return data
      .split("\n")
      .filter((s) => s.length > 0)
      .map((text) => ({ kind, level: "stderr" as LogLevel, summary: text }));
  }
  // stdout may be claude stream-json (one JSON per line) or plain text from
  // codex / opencode. Try JSON parse per line; fall back to raw text.
  const out: LogLine[] = [];
  for (const rawLine of data.split("\n")) {
    if (!rawLine) continue;
    const parsed = parseClaudeEventAll(rawLine);
    if (parsed.length > 0) {
      out.push(...parsed);
    } else {
      out.push({ kind, level: "info", summary: rawLine });
    }
  }
  return out;
};

export function MergeDialog({ lang, skill, sync, onMerged, onClose }: MergeDialogProps): JSX.Element {
  const t = messages[lang];
  const [selectedFrom, setSelectedFrom] = useState<ReadonlySet<string>>(() => {
    return new Set(sync.instances.filter((entry) => entry.status === "drifted").map((entry) => entry.realPath));
  });
  const [reviewers, setReviewers] = useState<ReviewerInfo[] | null>(null);
  const [byAgent, setByAgent] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("picking");
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<readonly LogLine[]>([]);
  const [expandedRaw, setExpandedRaw] = useState<ReadonlySet<number>>(new Set());
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [mergeResult, setMergeResult] = useState<SyncMergeResult | null>(null);
  const [pushAllBusy, setPushAllBusy] = useState(false);
  const [pushAllDone, setPushAllDone] = useState<SyncPushResult[] | null>(null);
  const [copyConfirm, setCopyConfirm] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef);

  const isWorking = phase === "working";

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase !== "working") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, phase]);
  useEffect(() => {
    let cancelled = false;
    api.reviewers()
      .then((result) => { if (!cancelled) setReviewers(result.reviewers); })
      .catch(() => { if (!cancelled) setReviewers([]); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const panel = logPanelRef.current;
    if (!panel) return;
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 20;
    if (atBottom) panel.scrollTop = panel.scrollHeight;
  }, [logLines]);
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const availableReviewers = useMemo(
    () => (reviewers ?? []).filter((reviewer) => reviewer.kind !== "rules" && reviewer.available),
    [reviewers]
  );

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

  const canSubmit = fromAgentsForSubmit.length >= 2 && byAgent.length > 0 && phase !== "working";

  const submit = async () => {
    if (!canSubmit) return;
    setPhase("working");
    setError(null);
    setLogLines([]);
    setExpandedRaw(new Set());
    setMergeResult(null);
    setPushAllDone(null);
    setStartedAt(Date.now());
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await api.syncMergeStream(
        skill.name,
        fromAgentsForSubmit,
        byAgent,
        (kind, data) => {
          const newLines = chunkToLines(kind, data);
          if (newLines.length === 0) return;
          setLogLines((prev) => [...prev, ...newLines]);
        },
        { signal: controller.signal }
      );
      setMergeResult(result);
      setPhase("done");
    } catch (err) {
      // Abort fires both intentional cancel (controller.abort()) and remote
      // failures sometimes — distinguish by checking the signal flag.
      if (controller.signal.aborted) {
        setPhase("picking");
        setConfirmAbort(false);
        return;
      }
      setError(humanizeError(err, lang));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const requestAbort = () => {
    if (phase !== "working") return;
    setConfirmAbort(true);
  };
  const confirmAbortNow = () => {
    abortRef.current?.abort();
  };
  const cancelAbort = () => {
    setConfirmAbort(false);
  };

  const runPushAll = async () => {
    if (!mergeResult || pushAllBusy) return;
    setPushAllBusy(true);
    try {
      const out = await api.syncPushAll(skill.name);
      setPushAllDone(out.results);
    } catch (err) {
      setError(humanizeError(err, lang));
    } finally {
      setPushAllBusy(false);
    }
  };

  const closeAndPropagate = () => {
    if (mergeResult) onMerged(mergeResult);
    else onClose();
  };

  const copyLog = async () => {
    const text = logLines
      .map((line) => (line.rawJson ?? line.summary))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyConfirm(true);
      setTimeout(() => setCopyConfirm(false), 1500);
    } catch {
      // clipboard denied; nothing else to do
    }
  };

  const elapsedSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  // Render the live log frame — always rendered with fixed height across
  // working / done / error so the dialog doesn't visibly resize as chunks
  // arrive (sub-agent review of issue #2 noted the height jitter).
  const renderLogFrame = (): JSX.Element => (
    <div className="merge-log-frame">
      <div className="merge-log-head">
        <span>{t.mergeLogLabel}</span>
        <button
          type="button"
          className="ghost merge-log-copy"
          onClick={() => void copyLog()}
          disabled={logLines.length === 0}
          title={t.mergeLogCopy}
        >
          {copyConfirm ? <Check size={12} /> : <Copy size={12} />}
          {copyConfirm ? t.mergeLogCopied : t.mergeLogCopy}
        </button>
      </div>
      <div className="merge-log" ref={logPanelRef}>
        {logLines.length === 0 ? (
          <span className="merge-log-waiting">{t.mergeLogWaiting}</span>
        ) : (
          logLines.map((line, index) => {
            const expanded = expandedRaw.has(index);
            return (
              <div key={index} className={`merge-log-line merge-log-${line.level}`}>
                <span
                  className={line.rawJson ? "merge-log-summary clickable" : "merge-log-summary"}
                  onClick={() => {
                    if (!line.rawJson) return;
                    setExpandedRaw((prev) => {
                      const next = new Set(prev);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    });
                  }}
                  title={line.rawJson ? t.mergeLogShowRaw : undefined}
                >
                  {line.summary}
                </span>
                {expanded && line.rawJson && (
                  <pre className="merge-log-raw">{line.rawJson}</pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-dialog-title"
      onClick={(event) => { if (event.target === event.currentTarget && !isWorking) closeAndPropagate(); }}
    >
      <div ref={dialogRef} tabIndex={-1} className="dialog merge-dialog" onClick={(event) => event.stopPropagation()}>
        <button
          className="dialog-close"
          onClick={isWorking ? requestAbort : closeAndPropagate}
          aria-label={isWorking ? t.mergeAbortButton : t.cancel}
          title={isWorking ? t.mergeAbortButton : t.cancel}
        >
          <X size={16} />
        </button>
        <h2 id="merge-dialog-title">{t.mergeDialogTitle.replace("{name}", skill.name)}</h2>

        {phase === "picking" && (
          <p className="muted-copy">{t.mergeDialogBody}</p>
        )}

        {/* Working — spinner, elapsed, abort confirmation if requested. */}
        {phase === "working" && (
          <div className="merge-progress">
            <Loader2 className="spin" size={24} />
            <p className="merge-progress-title">
              {t.mergeWorkingTitle.replace("{name}", skill.name)}
            </p>
            <p className="muted-copy">
              {t.mergeWorkingBody.replace("{agent}", agentTone[byAgent]?.label ?? byAgent)} · {t.mergeElapsed.replace("{seconds}", String(elapsedSeconds))}
            </p>
            {confirmAbort && (
              <div className="merge-abort-confirm">
                <p>{t.mergeAbortConfirm.replace("{seconds}", String(elapsedSeconds))}</p>
                <div className="merge-abort-actions">
                  <button className="ghost" type="button" onClick={cancelAbort}>{t.mergeAbortKeepRunning}</button>
                  <button className="primary danger" type="button" onClick={confirmAbortNow}>
                    <Square size={14} /> {t.mergeAbortYes}
                  </button>
                </div>
              </div>
            )}
            {renderLogFrame()}
          </div>
        )}

        {/* Done — success summary, drift explanation, optional push-all. */}
        {phase === "done" && mergeResult && (
          <div className="merge-done">
            <div className="merge-done-head">
              <Check size={20} className="merge-done-icon" />
              <div>
                <p className="merge-done-title">{t.mergeDoneHeadline.replace("{name}", mergeResult.name)}</p>
                <p className="muted-copy">
                  {t.mergeDoneSummary
                    .replace("{from}", mergeResult.fromAgents.map((agent) => agentTone[agent]?.label ?? agent).join(" + "))
                    .replace("{agent}", agentTone[mergeResult.byAgent]?.label ?? mergeResult.byAgent)
                    .replace("{attempts}", String(mergeResult.attempts))}
                  {mergeResult.shortSha && <> · <code>{mergeResult.shortSha}</code></>}
                </p>
              </div>
            </div>
            {mergeResult.otherDrifted.length > 0 && pushAllDone === null && (
              <div className="merge-done-drift">
                <p>
                  {t.mergeDoneDrift.replace("{n}", String(mergeResult.otherDrifted.length))}
                </p>
                <button
                  className="primary"
                  type="button"
                  onClick={() => void runPushAll()}
                  disabled={pushAllBusy}
                >
                  {pushAllBusy ? <Loader2 className="spin" size={14} /> : <GitMerge size={14} />}
                  {t.mergePushAllAfterMerge.replace("{n}", String(mergeResult.otherDrifted.length))}
                </button>
              </div>
            )}
            {pushAllDone !== null && (
              <p className="merge-done-pushed">
                <Check size={14} /> {t.mergePushAllDone.replace("{n}", String(pushAllDone.length))}
              </p>
            )}
            {renderLogFrame()}
          </div>
        )}

        {/* Error — the merge failed; keep log around for inspection, offer retry. */}
        {phase === "error" && (
          <div className="merge-error">
            <p className="danger-line"><X size={14} /> {error}</p>
            <p className="muted-copy">{t.mergeErrorHint}</p>
            {renderLogFrame()}
          </div>
        )}

        {phase === "picking" && (
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
          {phase === "picking" && (
            <>
              <button className="ghost" onClick={onClose}>{t.cancel}</button>
              <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
                <GitMerge size={16} /> {t.mergeStartButton}
              </button>
            </>
          )}
          {phase === "working" && !confirmAbort && (
            <button className="ghost danger" onClick={requestAbort}>
              <Square size={14} /> {t.mergeAbortButton}
            </button>
          )}
          {phase === "done" && (
            <button className="primary" onClick={closeAndPropagate}>{t.mergeDoneCloseButton}</button>
          )}
          {phase === "error" && (
            <>
              <button className="ghost" onClick={onClose}>{t.cancel}</button>
              <button className="primary" onClick={() => void submit()}>
                <RotateCcw size={14} /> {t.mergeRetryButton}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
