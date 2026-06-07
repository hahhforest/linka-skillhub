# linka-skillhub

Local-first skill management for code agents (Mavis / OpenCode / Claude Code / Codex / Cursor / OpenClaw / Hermes). Scans, validates, imports, reviews, reconciles, and distributes skills across agents and machines — with a Git-versioned registry at the center and an optional Web console for everything that isn't a single shell call.

Primary command: `lsh` (alias: `linka-skillhub`). Use `pnpm lsh` or `npx lsh` if you already have an unrelated `lsh` on `$PATH`.

## Why

Multiple coding agents, each with its own `skills/` directory, each editing skills in place, no shared history. linka-skillhub is the layer that:

- **Scans** every agent's skill source dirs and groups by (agent, scope).
- **Imports** skills into a single Git-versioned registry (`registry/skills/<name>/`) so you can diff, revert, and share.
- **Reviews** each skill (deterministic rules + optional code-agent reviews) and writes review artifacts; scan-time rules classify skills as `valid` / `portable` / `agent_bound` / `unsafe` / `invalid`.
- **Distributes** registry skills to one or more agents (`registry → mavis`, `registry → codex + claude`, etc.) with preview-then-confirm.
- **Reconciles drift** between a registry canonical and the live instances under each agent's source dir (the sync subsystem: pull / push / push-all / fork / merge).
- **Surfaces the timeline**: per-skill history view backed by `git log` over the registry repo.

Two interfaces ship in one binary: a full CLI (primary, works on remote Linux with no display) and a Web console on `lsh serve` (the convenient way to drive the same flows from a browser). The Web console is a thin layer — every state-changing call goes through the same `core` functions the CLI uses.

## Install / run

```bash
pnpm install
pnpm mirror:local            # copy real ~/.mavis / ~/.claude / ~/.codex / ... into .sandbox/local-mirror
pnpm typecheck               # tsc on packages/core + cli + apps/web
pnpm test                    # vitest on all packages
pnpm build                   # produces packages/cli/dist + apps/web/dist
pnpm verify                  # typecheck + test + build + ui-audit + ui-flow-test (exit gate)
pnpm review:smoke            # optional: end-to-end smoke against every reviewer (not in verify)
pnpm serve                   # start the Web console + API on http://127.0.0.1:4873
```

`pnpm verify` is the iteration exit gate — all five steps must pass before shipping a change. `ui-audit` walks the running Web console looking for a11y / overflow / contrast regressions; `ui-flow-test` exercises a few canonical paths (refresh, import-confirm, search, view switching).

The Web bundle is built by Vite. The CLI serves the static bundle from `apps/web/dist` on the same port as the API; open `http://127.0.0.1:4873` in any browser.

## Profiles

linka-skillhub has three profiles. The active profile is chosen by `--profile <name>` (CLI) or by editing `linka-skillhub.config.json`. The profile decides which source dirs are scanned and which target dirs writes land in.

| Profile | Source dirs | Target dirs | Purpose |
|---|---|---|---|
| `mirror` | `.sandbox/local-mirror/sources/**` (snapshots of real agent dirs) | `.sandbox/local-mirror/targets/**` | **Default.** Real-content testing without touching the user's real skills. |
| `sandbox` | tiny synthetic fixtures | tiny synthetic targets | Reproducible unit / e2e tests. |
| `local` | the real `~/.codex/skills`, `~/.claude/skills`, `~/.mavis/skills`, etc. | the same | Real writes. Opt-in only. |

```bash
lsh --profile local list                        # scan the real machine
lsh --profile local list --all --json           # include builtin / system
lsh config list                                  # show the resolved config
lsh profile show                                 # show the active profile + paths
```

`mirror` is the default because every write goes to a sandbox by design. To make changes that actually land in `~/.codex/skills/...`, you must explicitly opt in with `--profile local` (and a `--yes` for non-interactive).

## Commands

```
lsh list                           scan + list (alias: `lsh scan` deprecated)
lsh registry import [--create]     import scanned skills into the registry repo
lsh registry list                  list registry skills
lsh registry show <id>             show one skill's frontmatter + evidence
lsh history <name>                 show the per-skill history (parsed git log)
lsh review --reviewer <kind>       run review (rules | codex | claude | opencode | mavis)
lsh distribute preview|apply --target <agents> --skill <ids>
lsh copy preview|apply --from <a> --to <b> --skill <ids>
lsh sync status                    show drift between canonicals and live instances
lsh sync pull <name> --from <a>    pull an instance's diff into the canonical
lsh sync push <name> --to <a>      push the canonical over an instance
lsh sync push-all <name>           push the canonical to every drifted instance
lsh sync fork <name> --from-instance <a> --as <newName>
lsh sync merge <name> --from <a,b,...> --by <agent>
                                   spawn a code agent to reconcile multiple instances
lsh repo status|connect|pull|push  manage the registry's Git remote
lsh fix frontmatter <id> [--allow-unsafe-source]   repair a missing/broken SKILL.md frontmatter
lsh serve                          start the Web console + API
lsh config list                    show the resolved config
lsh profile show                   show the active profile + paths
```

`<agents>` and `<a>` are built-in agent kinds: `mavis`, `opencode`, `claude`, `codex`, `cursor`, `openclaw`, `hermes`, `shared` (the `.agents/skills` dir). The Web/API scanner can surface custom kinds declared in `linka-skillhub.config.json`; CLI write commands still validate against the built-in list.

### Write operations

Import, copy/distribute apply, repo push, and frontmatter fix show the source / target / action and ask for `y/N` confirmation in a TTY. In non-interactive mode those commands require an explicit `--yes` (or `LINKA_SKILLHUB_FORCE_YES=1`). The Web console enforces copy/distribute writes with a server-side two-step flow: `/api/distributions/plan` creates a cached plan and returns a `confirmToken`; `/api/distributions/apply` only accepts that cached token and never trusts a client-supplied plan body. Sync write commands are direct today; the UI limits them to per-instance drift actions, but adding the same preview-token gate is still a design follow-up.

```bash
lsh distribute preview --target codex,claude --skill smart-commit
lsh distribute apply  --target codex,claude --skill smart-commit --yes
lsh sync pull   writing-plans --from claude
lsh sync merge  writing-plans --from claude,hermes --by claude --timeout-ms 600000
```

## Web console

`lsh serve` (default `http://127.0.0.1:4873`) opens the same flows through a browser. Four pages, all backed by the same `/api/...` endpoints the CLI calls:

- **Overview** — stat cards (total / shareable / agent-bound / problematic), source-distribution bars, status donut, search, agent filter, per-skill detail panel.
- **Intersect (A→B copy)** — pick a source agent + target agent, select skills from the left, preview the copy plan, apply.
- **Distribute (registry → many)** — pick target agents, select registry skills, preview the multi-target plan, apply.
- **Repo (registry management)** — import, load existing registry, run review, refresh git status, bind to a GitHub remote, pull, push, per-skill history.

Per-skill detail panel (visible on every page that lists skills) surfaces:

- **Metadata**: source agent, scope, hash.
- **Instances**: live paths under each agent, status (`in-sync` / `drifted` / `missing`), per-instance `pull` / `push` / `fork` actions, plus `push-all` and `merge` at the card level.
- **History**: parsed `git log` for the canonical — import / pull / merge / fork / other.
- **Evidence**: scan-time parse issues + deterministic evidence codes; review artifacts are written under `registry/reviews/`. `fix frontmatter` appears when status contains `invalid`.

The language toggle (zh / en) sits in the top bar. Operational selection is page-local: Intersect and Distribute keep their own checkbox sets and clear them on view changes. The focused detail skill is shared across pages so a user can inspect the same skill while moving from Overview to Repo or Distribute.

## Registry layout

A v2 registry (created by `lsh registry import`) is a Git repo with this layout:

```
registry/
  skills/<name>/SKILL.md        canonical copy of the skill
  .gitignore                    ignores local derived state such as instances.json
  instances.json                local derived state; ignored by Git because it stores machine paths
  skills.json                   v2 manifest; canonical-per-name
  reviews/<skillId>-<reviewer>.json   per-review artifacts
prompts/
  skill-review-v1.md            frozen review prompt (zh + en variants)
```

`registry/skills/<name>/` is the canonical of record. Canonical-mutating writes — import, pull, merge, fork — produce per-skill `git commit` subjects that `lsh history <name>` can parse. Registry metadata (`registry/skills.json`, `registry/.gitignore`, and prompt snapshots when present) is committed separately so a registry import/sync does not leave tracked metadata dirty, while machine-local `instances.json` stays out of Git.

```
import <name> (origin: <agent>)
pull   <name> (from <agent>)
merge  <name> (<a> + <b> + ...)
fork  <name> (from <agent>)
update registry metadata
```

The merge subject is produced by linka-skillhub, not the user — see `packages/core/src/sync.ts`. Anything that doesn't match a known subject shows up as `other` with the raw subject preserved.

## Sync subsystem

The sync layer reconciles the **canonical** (`registry/skills/<name>/`) against the **live instances** on disk (the (agent, scope) source dirs the registry imported from).

- `pull <name> --from <a>` — overwrite the canonical with the live content under `<a>`; bumps the canonical hash; every other live instance becomes `drifted`.
- `push <name> --to <a>` — overwrite `<a>`'s live content with the canonical; `<a>` becomes `in-sync` again.
- `push-all <name>` — push the canonical to every drifted instance.
- `fork <name> --from-instance <a> --as <newName>` — create a new canonical from `<a>`'s content under a new name. The new name must match `^[a-z][a-z0-9-]*$`.
- `merge <name> --from <a,b,...> --by <agent>` — prepare a workspace at `<repo>/.merges/<uid>/` containing `a/`, `b/`, …, `target/`, and a `INSTRUCTIONS.md`. Spawn the named agent CLI to read those copies and write the reconciled canonical into `target/`. The agent must write a valid `SKILL.md` (or the merge is retried once with the failure reason appended to the prompt). Workspace is kept permanently for debugging.

The merge workspace is git-ignored inside the registry repo (`.merges/`), so agent writes don't bleed into `git log` of the canonical.

## Configuration

`linka-skillhub.config.json` is discovered by walking up from the working directory. The schema declares profiles, source / target paths, and the list of agents to expose:

```json
{
  "profiles": {
    "mirror": { "registryRepo": ".sandbox/local-mirror/targets/registry", "stateDir": ".sandbox/local-mirror/state" },
    "sandbox": { "registryRepo": ".sandbox/sandbox/registry", "stateDir": ".sandbox/sandbox/state" },
    "local":   { "registryRepo": "~/skillhub/registry", "stateDir": "~/.local/share/linka-skillhub" }
  },
  "activeProfile": "mirror"
}
```

CLI / WebUI never accept arbitrary write roots for registry operations — every registry write targets the active session repo after path-safety checks (`assertPathInside`). Custom source directories can be added through the Web console when they live inside the active profile root; the scanner surfaces those custom agent kinds, while some CLI write commands still use the built-in agent enum.

## Default safety policy

These rules apply in every profile and every interface (CLI + Web):

- **Real-agent dirs are opt-in.** Default `mirror` writes to a sandbox; `local` profile is the only one that touches `~/.codex/skills`, `~/.claude/skills`, etc.
- **Reviews are user-driven.** Code-agent reviewers (`codex`, `claude`, `opencode`, `mavis`) are off by default; the dialog surfaces availability per agent and only proceeds after explicit confirmation.
- **`unsafe` / `invalid` skills are excluded by default** from one-click distribute. `--include-unsafe` / `--include-agent-bound` is the explicit opt-in.
- **Overwrite is loud.** A pre-flight preview lists every `copy` / `overwrite` / `skip` line with the source / target / reason, and a backup lands in `<stateDir>/backups` before the first overwrite. Web apply requires a live server-side `confirmToken`; expired, unknown, or forged plan IDs are rejected.
- **No exposed internal verbs.** The UI never says "generate plan" or "execute plan" — it says "预览复制结果" / "确认复制到选中的目标 Agent" and equivalent. Same for sync: "用中心覆盖这份", "另存为新 skill", "把这份改动拉回中心".
- **Server-side validation.** The HTTP layer re-validates every path and agent kind; the WebUI cannot bypass profile safety by constructing a custom URL.

## Architecture

The monorepo has two Node packages and one browser app. Runtime dependencies flow from CLI/server to core; the Web app talks to the CLI HTTP server and imports only shared TypeScript types from `@linka-skillhub/core`. The core package is Node-oriented (`fs/promises`, `child_process`, `crypto`), so browser code must not import core values at runtime.

```
packages/core    Node-oriented domain/workflow functions on top of fs/promises
                 — registry.ts (read / write manifest + canonical)
                 — scanner.ts   (scan + classify skill frontmatter)
                 — frontmatter.ts, frontmatter-fix.ts
                 — review.ts    (rules + code-agent dispatch)
                 — distribution.ts (preview + apply distribute)
                 — repo.ts      (git commit / push / pull / remote)
                 — sync.ts      (pull / push / push-all / fork / merge)
                 — history.ts   (parse git log into action / agents / ts)
                 — types.ts, agents.ts, config.ts, hash.ts, path-safety.ts, summary.ts, safety.ts

packages/cli     commander + Node http server; serves /api/* and the static Web bundle
                 — index.ts:  every CLI subcommand
                 — server.ts: 26 routes (/api/skills, /api/sync/*, /api/repo/*, /api/fix/*, /api/distributions/*, …)
                 — prompts.ts: review prompt templates

apps/web         React + Vite; no runtime node imports
                 — App.tsx + 4 page components (Overview / Intersect / Distribute / Repo)
                 — DetailPanel (per-skill metadata + instances + history + fix-frontmatter button)
                 — MergeDialog (multi-instance reconciliation UI with phase machine + log)
                 — FixFrontmatterDialog, ConnectRemoteDialog, LoadRegistryDialog, ImportConfirmDialog
                 — api.ts: 1:1 thin wrapper around /api/* server routes — no write business logic
                 — i18n.ts (zh + en), styles.css
```

`apps/web/src/api.ts` is the thin client: every method is one `fetch` call to a CLI server route. Write behavior stays server/core-owned; the Web layer owns presentation state, filtering, and localized copy.

## Verify

```bash
pnpm verify
```

Runs, in order:

1. `pnpm typecheck` — tsc on all three packages.
2. `pnpm test` — vitest, ~75 tests across core / cli / web.
3. `pnpm build` — esbuild via tsc for core/cli, Vite for web.
4. `node scripts/ui-audit.mjs` — boots a headless Chrome via `playwright-core`, walks the Web console looking for a11y / overflow / contrast issues. Fails on any issue.
5. `node scripts/ui-flow-test.mjs` — exercises the canonical paths (search, source-bar selection, view switching, dialog open/close).

`pnpm review:smoke` is opt-in: it boots every reviewer (rules, codex, claude, opencode, mavis) once each and requires the rules reviewer to succeed. External reviewers may be marked available or not based on which CLIs are on `$PATH`. Not part of `verify`.

## Known limits

- The merge subsystem spawns a code-agent CLI and trusts it to write into `target/`. A failed validation runs the agent one more time with the failure reason appended to the prompt; if that also fails, the workspace is kept at `<repo>/.merges/<uid>/` for manual inspection.
- WebUI is a thin layer over the same `core` functions the CLI uses. Anything you can do in the Web console you can do in the CLI; the inverse is not yet true (`lsh fix frontmatter` was the last CLI-only escape hatch, now also exposed in the Web).
- The merge workspace accumulates. Delete `<repo>/.merges/` manually once you've confirmed each merge's commit.

## License

MIT. See `LICENSE`.
