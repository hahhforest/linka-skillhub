---
type: "final"
status: "ready_for_review"
owner: "Owner"
updated_at: "2026-05-21T23:25:00+08:00"
next: "Owner"
---
# linka-skillhub safe mirror testing

## Result
- Added a real local-skill mirror workflow: real skill packages are copied into `.sandbox/local-mirror`, then the app scans/imports/distributes only inside that mirror.
- Added `mirror` profile as the default profile in `linka-skillhub.config.json`.
- Added `.agents/skills` as a first-class `shared` source/target instead of attributing it to OpenCode.
- Hardened API/distribution safety: apply recomputes plans server-side, registry paths are locked to the active profile repo, backup paths use profile stateDir, and skill path segments are sanitized/contained.
- Added Playwright-core smoke testing with screenshots under `.sandbox/ui-smoke`.
- Created and pushed private GitHub repo `hahhforest/my-skills` from the mirrored registry.

## Artifacts
- Mirror root: `.sandbox/local-mirror`
- Registry repo: `.sandbox/my-skills-registry`
- UI screenshots: `.sandbox/ui-smoke`
- Team workspace: `.agents/team-work/skillhub-safe-mirror`

## Verification
- `pnpm mirror:local` copied 229 real skill packages into mirror sources/targets.
- `pnpm scan` scanned mirror profile: 105 default-selected skills, 104 valid, 93 portable, 12 agent-bound, 1 invalid.
- `pnpm --filter @linka-skillhub/cli start -- import` imported 105 mirrored skills into `.sandbox/my-skills-registry`.
- CLI distribution copied `1password` into mirror Codex target and confirmed real `/Users/minimax/.codex/skills` was unchanged.
- Malicious API registry path `/tmp/not-allowed` was rejected.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm smoke:ui` passed.

## Risks
- The private GitHub repo contains real mirrored skill content. It was created private, but some skills include caches/docs from their package directories.
