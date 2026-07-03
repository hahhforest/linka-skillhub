# Hermes Tweet Registry Example

This example shows how `linka-skillhub` can mirror and distribute Hermes Tweet as a shared Hermes Agent skill.

Hermes Tweet adds X/Twitter research, reading, and gated action support for Hermes Agent. Treat it as a registry skill that can be reviewed once, then distributed to trusted agent targets.

## Import Into The Registry

Clone Hermes Tweet and import the packaged skill directory into the active registry profile:

```bash
git clone https://github.com/Xquik-dev/hermes-tweet.git
pnpm lsh -- registry import ./hermes-tweet/hermes_tweet/skills/hermes-tweet --create
```

Review the imported frontmatter and files before distributing:

```bash
pnpm lsh -- review --reviewer rules --skill hermes-tweet
pnpm lsh -- distribute preview --target hermes --skill hermes-tweet
```

Apply distribution only after the preview is correct:

```bash
pnpm lsh -- distribute apply --target hermes --skill hermes-tweet --yes
```

## Runtime Gates

Store values outside the registry and keep only variable names in notes.

| Name | Purpose |
| --- | --- |
| `XQUIK_API_KEY` | Required for live read tools. |
| `HERMES_TWEET_ENABLE_ACTIONS` | Enables write actions only when set to `true`. |

For most teams, distribute the skill first with action tools disabled, then enable action access per agent after an operator approves the runbook.
