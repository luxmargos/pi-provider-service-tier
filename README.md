# @luxmargos/pi-provider-service-tier

[![npm version](https://img.shields.io/npm/v/@luxmargos%2Fpi-provider-service-tier.svg)](https://www.npmjs.com/package/@luxmargos/pi-provider-service-tier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Pi extension](https://img.shields.io/badge/Pi-extension-purple.svg)](https://github.com/luxmargos/pi-provider-service-tier)

A Pi extension that lets you choose an API `service_tier` per provider/model.

Use it when you want to turn on faster or paid priority tiers for one model without changing your prompts, tools, selected model, or the rest of your Pi setup.

## What it does

- Adds a top-level `service_tier` field to outgoing provider request payloads.
- Scopes settings to the current `provider/model` pair.
- Supports project-local settings and user-global defaults.
- Provides simple `/fast-*` commands for `service_tier: "priority"`.
- Keeps a support map so unsupported provider/model pairs are not modified.
- Detects unsupported tier errors and updates the support map.

The extension only injects `service_tier` when all of these are true:

1. the current `provider/model` pair is active in the effective config,
2. a service tier is configured for that pair, and
3. the support map says that tier is supported for that pair.

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
pi install npm:@luxmargos/pi-provider-service-tier
```

Inside Pi:

```text
/reload
/fast-project on
/fast-project status
```

Use `pi install -l npm:@luxmargos/pi-provider-service-tier` instead if you want a project-local install rather than a user-global install.

## Installation details

### Install from npm

Install globally for your Pi user settings:

```bash
pi install npm:@luxmargos/pi-provider-service-tier
```

Or install only for the current project:

```bash
pi install -l npm:@luxmargos/pi-provider-service-tier
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
pi remove npm:@luxmargos/pi-provider-service-tier
```

Remove the project-local npm install:

```bash
pi remove -l npm:@luxmargos/pi-provider-service-tier
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
| `/fast-project` | Current project | Toggle priority tier for the current provider/model. |
| `/fast-project on` | Current project | Enable priority tier. |
| `/fast-project off` | Current project | Disable this extension for the current provider/model in this project. |
| `/fast-project status` | Current project | Show the current project setting. |
| `/fast-user` | User-global | Toggle priority tier for the current provider/model. |
| `/fast-user on` | User-global | Enable priority tier as a user default. |
| `/fast-user off` | User-global | Disable the user-global setting for the current provider/model. |
| `/fast-user status` | User-global | Show the current user-global setting. |

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

### Build or refresh the support map

```text
/service-tier-build-map
/service-tier-build-map-all
```

- `/service-tier-build-map` updates the support map for the current provider/model.
- `/service-tier-build-map-all` updates the support map for all models returned by Pi's model registry.

With aggressive probing off, map building uses bundled presets. With aggressive probing on, the extension sends low-token probe requests for each tier and model.

Toggle aggressive probing for the current project config:

```text
/service-tier-aggressive-probe
/service-tier-aggressive-probe on
/service-tier-aggressive-probe off
/service-tier-aggressive-probe status
```

> [!WARNING]
> Aggressive probing can cost money and trigger provider rate limits. It is off by default.

### Debug injection decisions

```text
/service-tier-debug on
/service-tier-debug off
/service-tier-debug status
```

Debug mode is session-local. When enabled, the extension notifies whether each provider request was injected with `service_tier` or skipped.

## Configuration files

The npm package is scoped as `@luxmargos/pi-provider-service-tier`. Runtime config files continue to use `pi-provider-service-tier` as their stable config-file identity.

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
  "version": 1,
  "aggressiveProbe": false,
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

`aggressiveProbe` defaults to `false`. Use `/service-tier-aggressive-probe [on|off|status]` to manage the project config, or set it manually in either config file. Project config overrides user config for this field.

## Support map schema

Example:

```json
{
  "version": 1,
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

Other providers/models are marked unsupported by presets until aggressive probing or future presets add support.

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

`npm run check` runs TypeScript type checking, Node tests, and `npm pack --dry-run` to verify the published package contents.

## License

MIT
