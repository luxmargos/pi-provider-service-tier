# pi-provider-service-tier

[![npm version](https://img.shields.io/npm/v/pi-provider-service-tier.svg)](https://www.npmjs.com/package/pi-provider-service-tier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Pi extension](https://img.shields.io/badge/Pi-extension-purple.svg)](https://github.com/luxmargos/pi-provider-service-tier)

A Pi extension that lets you choose an API `service_tier` per provider/model.

Use it when you want to turn on faster or paid priority tiers for one model without changing your prompts, tools, selected model, or the rest of your Pi setup.

## What it does

- Adds a top-level `service_tier` field to outgoing provider request payloads.
- Scopes settings to the current `provider/model` pair.
- Supports project-local settings and user-global defaults.
- Provides simple `/service-tier-fast-*` commands for `service_tier: "priority"`.
- Keeps a support map so unsupported provider/model pairs are not modified.
- Detects unsupported tier errors and updates the support map.

The extension only injects `service_tier` when all of these are true:

1. the current `provider/model` pair is active in the effective config,
2. a service tier is configured for that pair, and
3. the support map says that tier is supported for that pair, or unsupported behavior explicitly authorizes an aggressive injection.

> [!NOTE]
> This extension injects the provider payload field `service_tier`. For Pi's built-in OpenAI providers, Pi also has an internal `serviceTier` stream option used for cost accounting. This extension is intentionally broader and payload-hook based, so it does not adjust Pi's internal cost multiplier.

## Prerequisites

- Pi installed and available as `pi`.
- Node.js `>=22`.
- `git`, if installing directly from GitHub.
- A provider/model that supports `service_tier` if you want injection to happen.

## Quick start

Install the package, reload Pi, then enable priority mode for the current provider/model.

```bash
pi install npm:pi-provider-service-tier
```

Inside Pi:

```text
/reload
/service-tier-fast-project on
/service-tier-fast-project status
```

Use `pi install -l npm:pi-provider-service-tier` instead if you want a project-local install rather than a user-global install.

## Installation details

### Install from npm

Install globally for your Pi user settings:

```bash
pi install npm:pi-provider-service-tier
```

Or install only for the current project:

```bash
pi install -l npm:pi-provider-service-tier
```

Restart Pi, or run `/reload` inside Pi after installing.

### Install from GitHub

Install globally for your Pi user settings:

```bash
pi install git:github.com/luxmargos/pi-provider-service-tier
```

Or install only for the current project:

```bash
pi install -l git:github.com/luxmargos/pi-provider-service-tier
```

### Clone locally

```bash
git clone https://github.com/luxmargos/pi-provider-service-tier.git
cd pi-provider-service-tier
npm install
```

Load it temporarily for one Pi run:

```bash
pi -e .
```

Or install the local checkout for the current project:

```bash
pi install -l .
```

Restart Pi or run `/reload`, then enable a tier:

```text
/service-tier-project priority
```

### Verify or remove

List installed Pi packages:

```bash
pi list
```

Remove the user-global npm install:

```bash
pi remove npm:pi-provider-service-tier
```

Remove the project-local npm install:

```bash
pi remove -l npm:pi-provider-service-tier
```

Remove the user-global GitHub install:

```bash
pi remove git:github.com/luxmargos/pi-provider-service-tier
```

Remove the project-local GitHub install:

```bash
pi remove -l git:github.com/luxmargos/pi-provider-service-tier
```

Remove the project-local local checkout install:

```bash
pi remove -l .
```

> [!TIP]
> Do not load the same checkout with `pi -e .` while it is also installed with `pi install -l .`. Pi may load duplicate commands with numeric suffixes.

## Common usage

### Fast mode

Fast mode is a convenience wrapper for enabling `service_tier: "priority"` for the current provider/model.

| Command | Scope | Description |
| --- | --- | --- |
| `/service-tier-fast-project` | Current project | Toggle priority tier for the current provider/model. |
| `/service-tier-fast-project on` | Current project | Enable priority tier. |
| `/service-tier-fast-project off` | Current project | Disable this extension for the current provider/model in this project. |
| `/service-tier-fast-project status` | Current project | Show the current project setting. |
| `/service-tier-fast-user` | User-global | Toggle priority tier for the current provider/model. |
| `/service-tier-fast-user on` | User-global | Enable priority tier as a user default. |
| `/service-tier-fast-user off` | User-global | Disable the user-global setting for the current provider/model. |
| `/service-tier-fast-user status` | User-global | Show the current user-global setting. |

The older `/fast-project` and `/fast-user` commands remain available as aliases.

### Explicit service tiers

Use these commands when you want a tier other than `priority`.

| Command | Scope | Arguments |
| --- | --- | --- |
| `/service-tier-project <tier>` | Current project | `priority`, `flex`, `default`, `auto`, `scale`, `off`, `status` |
| `/service-tier-user <tier>` | User-global | `priority`, `flex`, `default`, `auto`, `scale`, `off`, `status` |

Examples:

```text
/service-tier-project flex
/service-tier-project off
/service-tier-user priority
/service-tier-user status
```

Commands apply only to the current provider/model pair. Argument completions are available; type a command plus a space, then press Tab.

### Refresh or unset support

```text
/service-tier-refresh-support
/service-tier-refresh-support-all
/service-tier-unset-support
/service-tier-unset-support-all
```

- `/service-tier-refresh-support` refreshes preset support for the current provider/model.
- `/service-tier-refresh-support-all` refreshes preset support for all models returned by Pi's model registry.
- `/service-tier-unset-support` removes the current provider/model from the support map, making support unknown.
- `/service-tier-unset-support-all` clears the support map, making support unknown for all models.

Refresh commands are preset-only and do not call providers. Unset commands do not mark models unsupported.

### Unsupported behavior

```text
/service-tier-unsupported-behavior ask
/service-tier-unsupported-behavior aggressive
/service-tier-unsupported-behavior unsupported
/service-tier-unsupported-behavior status
```

`ask` is the default. When an explicit tier, fast, or refresh command selects a tier that stored support says is unsupported, Pi prompts with:

- `Use aggressive mode once`
- `Use aggressive mode and do not ask again`
- `Leave unsupported once`
- `Leave unsupported and do not ask again`

`aggressive` injects the configured tier even when support is unknown or unsupported. `unsupported` leaves unknown or unsupported tiers uninjected. The command writes user-global config.

`Use aggressive mode once` authorizes one request and records the observed result in the user-global support map. A successful assistant response marks the tier supported; an unsupported `service_tier` provider error marks it unsupported. The failed request is not retried.

### Debug injection decisions

```text
/service-tier-debug on
/service-tier-debug off
/service-tier-debug status
```

Debug mode is session-local. When enabled, the extension notifies whether each provider request was injected with `service_tier` or skipped.

## Configuration files

This package uses `pi-provider-service-tier` for package and config-file identity.

Project config:

```text
.pi/extensions/pi-provider-service-tier.json
```

User-global config:

```text
~/.pi/agent/extensions/pi-provider-service-tier.json
```

Global support map:

```text
~/.pi/agent/extensions/pi-provider-service-tier-map.json
```

Project and user configs are merged:

- user config provides defaults,
- project config overrides fields for the same provider/model key,
- provider/model entries that exist only in user config still apply in projects unless overridden.

If you previously used an older local package name, move or copy any existing `pi-service-tier*.json` files to the filenames above.

## Config schema

Example:

```json
{
  "version": 2,
  "unsupportedModelBehavior": "ask",
  "entries": {
    "openai/gpt-5.5": {
      "active": true,
      "serviceTier": "priority"
    },
    "openai/gpt-4.1": {
      "active": false,
      "serviceTier": "flex"
    }
  }
}
```

`unsupportedModelBehavior` is optional and defaults to `ask`. Valid values are `ask`, `aggressive`, and `unsupported`. Use `/service-tier-unsupported-behavior [ask|aggressive|unsupported|status]` to manage the user-global setting, or set it manually in either config file. Project config overrides user config for this field.

## Support map schema

Example:

```json
{
  "version": 2,
  "entries": {
    "openai/gpt-5.5": {
      "provider": "openai",
      "id": "gpt-5.5",
      "api": "openai-responses",
      "supported": true,
      "tiers": ["priority", "flex", "default", "auto", "scale"],
      "source": "preset",
      "updatedAt": "2026-05-19T00:00:00.000Z"
    }
  }
}
```

Preset support currently includes:

| Provider/API | Models | Tiers |
| --- | --- | --- |
| `openai` + `openai-responses` | all | `priority`, `flex`, `default`, `auto`, `scale` |
| `openai` + `openai-completions` | all | `priority`, `flex`, `default`, `auto`, `scale` |
| `openai-codex` + `openai-codex-responses` | probed models in `presets/openai-codex.json` | `priority`, `default` |
| `openai-codex` + `openai-codex-responses` | fallback for other models | `priority` |
| `opencode-go` + `openai-completions` | probed models in `presets/opencode-go.json` | model-specific; usually `priority`, `flex`, `default`, `auto`, `scale` |

Other providers/models remain unknown unless refreshed from presets, learned from an unsupported provider error, or updated by an aggressive-once result.

## Unsupported tier errors

If a provider returns an error indicating `service_tier` is unsupported or invalid, the extension:

1. removes that tier from the map entry for the current provider/model,
2. records it in `unsupportedTiers`,
3. notifies the user, and
4. does **not** retry the failed request.

## Development

```bash
git clone https://github.com/luxmargos/pi-provider-service-tier.git
cd pi-provider-service-tier
npm install
npm run check
```

Local smoke test:

```bash
pi -e . --provider openai --model gpt-5.5
```

Real latency comparison against Pi and your provider account:

```bash
npm run bench:service-tier
npm run bench:service-tier:swap # run priority before baseline in the first round
```

The benchmark loads this checkout for both runs with global extension discovery disabled, then compares one Pi `--print` completion with the project setting off against one with `service_tier: "priority"` on. It also inspects the user-global service-tier config and reports whether the target model already has priority enabled globally; the baseline still writes a project-local `active:false` override before Pi starts. It defaults to `openai-codex/gpt-5.5` and a no-tools prompt sized to make elapsed time measurable. This makes real provider calls and may cost money.

Useful overrides:

```bash
PST_BENCH_MODEL=openai-codex/gpt-5.5 npm run bench:service-tier
PST_BENCH_START_WITH=tier npm run bench:service-tier
PST_BENCH_ROUNDS=3 PST_BENCH_THINKING=high npm run bench:service-tier
PST_BENCH_PROMPT_FILE=./my-benchmark-prompt.md npm run bench:service-tier
PST_BENCH_MIN_CHARS=0 npm run bench:service-tier # disable minimum-output validation
PST_BENCH_TIER=default npm run bench:service-tier
```

`npm run check` runs TypeScript type checking, Node tests, and `npm pack --dry-run` to verify the published package contents.

## License

MIT
