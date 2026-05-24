# pi-provider-service-tier

Local Pi extension for provider/model-scoped `service_tier` management.

This extension modifies outgoing provider request payloads with a top-level `service_tier` only when:

1. the current `provider/model` pair is active in the effective config,
2. a service tier is configured for that pair, and
3. the persistent support map says that tier is supported for that pair.

It does not change the selected provider, model, thinking level, prompts, or tools.

> Note: this extension injects the request payload field `service_tier`. For Pi's built-in OpenAI providers, Pi also has an internal `serviceTier` stream option used for cost accounting. This extension is intentionally broader and payload-hook based, so it does not adjust Pi's internal cost multiplier.

## Local usage

### Temporary local test

From this repository, load the extension only for the current Pi run:

```bash
pi -e ./packages/pi-provider-service-tier
```

Or with explicit provider/model:

```bash
pi -e ./packages/pi-provider-service-tier --provider openai --model gpt-5.5
```

### Local project installation

Install the local package for this project so it loads whenever Pi is started from the repository:

```bash
pi install -l ./packages/pi-provider-service-tier
```

The `-l` flag writes the package entry to this repository's `.pi/settings.json` instead of the user-global `~/.pi/agent/settings.json`.

After installing, restart Pi or run:

```text
/reload
```

Verify the package is installed:

```bash
pi list
```

Remove the project-local install:

```bash
pi remove -l ./packages/pi-provider-service-tier
```

Do not use `-e ./packages/pi-provider-service-tier` at the same time as the installed project-local package, or Pi may load duplicate commands with numeric suffixes.

## Commands

### Fast wrappers

```text
/fast-project
/fast-project on
/fast-project off
/fast-project status

/fast-user
/fast-user on
/fast-user off
/fast-user status
```

Fast mode is a wrapper for enabling `service_tier: "priority"` for the current provider/model pair.

- `/fast-project` writes project config.
- `/fast-user` writes user-global config.

### Explicit service tier

```text
/service-tier-project priority
/service-tier-project flex
/service-tier-project default
/service-tier-project auto
/service-tier-project scale
/service-tier-project off
/service-tier-project status

/service-tier-user priority
/service-tier-user flex
/service-tier-user default
/service-tier-user auto
/service-tier-user scale
/service-tier-user off
/service-tier-user status
```

By default, commands apply only to the current provider/model pair.

Argument completions are available for the service-tier, fast-mode, and debug commands. For example, type `/service-tier-project ` and press Tab to choose `priority`, `flex`, `default`, `auto`, `scale`, `off`, or `status`.

### Build support map

```text
/service-tier-build-map
/service-tier-build-map-all
```

- `/service-tier-build-map` updates the support map for the current provider/model.
- `/service-tier-build-map-all` updates the support map for all `ctx.modelRegistry.getAvailable()` models.

With aggressive probing off, map building uses bundled presets. With aggressive probing on, the extension sends low-token probe requests for each tier and model. Aggressive probing can cost money and trigger rate limits.

### Debug notifications

```text
/service-tier-debug on
/service-tier-debug off
/service-tier-debug status
```

Debug mode is session-local. When enabled, the extension notifies whether each provider request was injected with `service_tier` or skipped.

## Config files

This package uses `pi-provider-service-tier` for package and config-file identity. If you previously used the old local package name, move or copy any existing `pi-service-tier*.json` files to the filenames below.

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

Project and user configs are merged:

- user config provides defaults,
- project config overrides fields for the same provider/model key,
- provider/model entries that exist only in user config still apply in projects unless overridden.

`aggressiveProbe` defaults to `false`. Set it manually in either config file. Project config overrides user config for this field.

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

| Provider/API | Tiers |
| --- | --- |
| `openai` + `openai-responses` | `priority`, `flex`, `default`, `auto`, `scale` |
| `openai` + `openai-completions` | `priority`, `flex`, `default`, `auto`, `scale` |
| `openai-codex` + `openai-codex-responses` | `priority` |

Other providers are marked unsupported by presets until aggressive probing or future presets add support.

## Unsupported tier errors

If a provider returns an error indicating `service_tier` is unsupported or invalid, the extension:

1. removes that tier from the map entry for the current provider/model,
2. records it in `unsupportedTiers`,
3. notifies the user, and
4. does **not** retry the failed request.

## Development

```bash
cd packages/pi-provider-service-tier
npm install
npm run check
```

Local smoke test:

```bash
pi -e ./packages/pi-provider-service-tier --provider openai --model gpt-5.5
```
