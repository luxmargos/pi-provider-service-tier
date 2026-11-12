# Configuration reference

[User guide](../README.md) · [Support records and probes](support-and-probes.md)

Commands are the simplest way to change settings. This reference covers manual configuration, inheritance, validation, and recovery.

## File locations

| File | Location |
| --- | --- |
| Project settings | `<project>/.pi/extensions/pi-provider-service-tier.json` |
| User defaults | `~/.pi/agent/extensions/pi-provider-service-tier.json` |
| Shared support records | `~/.pi/agent/extensions/pi-provider-service-tier-map.json` |

Settings and support records are separate: enabling a tier changes config; manual records, explicitly approved probes, and provider errors update support records. No bundled information is seeded or refreshed. Support knowledge does not determine activation. See the [support-map schema](support-and-probes.md#support-map-schema).

For installations that used an older local package name, move or copy `pi-service-tier*.json` files to these filenames.

## Settings schema

Current schema version: `2`. Entries use `provider/model` keys, not bare model IDs.

```json
{
  "version": 2,
  "unknownModelBehavior": "ask",
  "entries": {
    "openai/gpt-5.5": {
      "active": true,
      "serviceTier": "priority"
    },
    "openai/gpt-6-astra": {
      "active": false,
      "serviceTier": "ultrafast"
    }
  }
}
```

- `active`: optional boolean. Only `true` enables an effective entry.
- `serviceTier`: optional `priority`, `flex`, `default`, `auto`, `scale`, `fast`, or `ultrafast`. These are selectable package values, not universal provider capabilities.
- `unknownModelBehavior`: optional `ask`, `auto-probe`, or `leave-unknown`; the default is `ask`. It controls support checking, not tier activation.
- `statusFormat`: optional root-level footer template; see [formatting](#footer-format). It changes presentation only, not activation or support evidence.

Use `active: false` to disable an entry. `"serviceTier": "off"` is not a valid tier. Fast convenience commands explicitly write `priority`; an omitted tier never supplies it implicitly.

## Footer format

The optional root-level `statusFormat` string controls the entire normal footer, including the `service_tier:` prefix, and reorders, repeats, or omits footer segments. When absent, the `minimal` template is used: `{label}: {symbol} {tier}`. Settings files are not shipped or created at startup just to store a default format.

Add this field to your existing user/project JSON **without replacing its other settings**. For a new settings file only, a minimal example is:

```json
{
  "version": 2,
  "statusFormat": "{symbol} {tier}{\" | \"support}",
  "entries": {}
}
```

| Token | Value |
| --- | --- |
| `{label}` | `service_tier`. Use literal text for a different heading. |
| `{symbol}` | Existing ⚡ / ● / ○ symbol for the configured state. |
| `{tier}` | Effective active tier, or `off`; not the server's last reported tier. |
| `{support}` | Saved-evidence label, e.g. `manual`, `unknown`, `probe-verified`, or `fallback`; empty when off. |
| `{fallback}` | Reported tier from the current saved fallback observation, e.g. `default`; empty for other evidence states or when off. |

Templates are single-line strings up to 256 characters. Escape literal braces as `{{` and `}}`; unknown/unmatched placeholders, terminal controls and newlines are invalid config. This is text substitution, not executable code. Replacements are non-recursive; inserted values are control-sanitized and bounded. Literal spacing is preserved. An empty/whitespace-only template hides normal footer status.

```text
/service-tier-status-format {symbol} {tier}{" | "support}
/service-tier-status-format Tier: {symbol} {tier}{" | "support}{" → "fallback}
/service-tier-status-format status
/service-tier-status-format reset
```

To rename the prefix, replace `{label}:` with literal text such as `Tier:`; omitting it removes the prefix. For example, `Tier: {symbol} {tier}{" | "support}{" → "fallback}` renders `Tier: ⚡ priority | fallback → default` for an active priority tier with saved fallback-to-default evidence. `{support}` supplies only `fallback`, and `{fallback}` supplies `default`. Omit `{" → "fallback}` to hide the reported tier, or omit both evidence segments for a shorter display.

### Conditional prefixes

Use `{"<prefix>"token}` to show the prefix and token together only when that segment is nonempty. Put any desired spaces **inside** the quotes:

```text
{label}: {symbol} {tier}{" | "support}{" → "fallback}
```

| Saved state | Rendered example |
| --- | --- |
| Fallback to default | `service_tier: ⚡ priority \| fallback → default` |
| Manual evidence, no fallback | `service_tier: ⚡ priority \| manual` |
| Off (both evidence segments empty) | `service_tier: ○ off` |

The prefix is a JSON string, so `\"` and `\\` escape a quote and backslash; decoded controls/newlines are invalid. This syntax works with any listed token, not just support/fallback. Empty or whitespace-only values after control sanitization and the 128-character segment limit omit the entire conditional token. Prefixes and inserted segment text are literal and never recursively formatted; braces inside a quoted prefix are literal. Outside quoted prefixes, keep using `{{` and `}}` for literal braces. The alternative `{|:support}` form and nested expressions are not supported.

Ordinary tokens and surrounding text are unchanged: `{tier} | {support}` still keeps ` | ` when support is empty. Use `{tier}{" | "support}` to make that separator conditional instead. Medium/long presets use conditional prefixes, so long without fallback has no trailing separator and off has no evidence separators.

### Length presets

`/service-tier-status-preset` is a wrapper for the format command, with argument completion. All three presets include the `service_tier:` label:

| Preset | Equivalent `/service-tier-status-format` argument | Example with saved fallback evidence |
| --- | --- | --- |
| `minimal` (default) | `{label}: {symbol} {tier}` | `service_tier: ⚡ priority` |
| `medium` | `{label}: {symbol} {tier}{" \| "support}` | `service_tier: ⚡ priority \| fallback` |
| `long` | `{label}: {symbol} {tier}{" \| "support}{" → "fallback}` | `service_tier: ⚡ priority \| fallback → default` |

```text
/service-tier-status-preset minimal
/service-tier-status-preset medium
/service-tier-status-preset long
/service-tier-status-preset status
```

No argument or `status` shows the effective format and all preset templates without saving. Completion labels show `minimal (default)` but insert the raw `minimal` argument. Every preset explicitly saves its template in user settings, creating the file if missing; it does not remove a project override. An absent `statusFormat` renders through the minimal template without creating a default property/file. Use `/service-tier-status-format reset` to remove the user override and return to minimal unless a project format takes precedence. Presets store no separate setting and do not change tiers, support records, or Probe policy.

Existing saved templates are not rewritten automatically. Reapply a preset to adopt its latest template, including conditional separators in `medium`/`long` and labels in older minimal/medium formats. Custom formats can still omit `{label}:` to hide the prefix.

Both commands write the **user** scope; a project override still takes precedence. A valid explicit save creates the user JSON if missing, without creating a project file or initializing/migrating support records. Status, invalid input, and reset with no stored override do not create settings files. The format command also accepts JSON-quoted templates; `""` hides the normal footer and `reset` removes only the user property, preserving other data and files.

Manual edits are read on the next provider-request check or `/reload`; the command refreshes the footer immediately when no Probe is running. Healthy formatting-only changes do not start/cancel a Probe, change a tier, or rewrite support evidence. Configuration/I/O errors retain the normal fail-closed cancellation behavior. Temporary Probe progress keeps its existing display. Config errors always show the built-in error status, even if normal status was hidden; blocked routes still show no extension footer. Green still means prior Probe verification, not guaranteed future service or billing.

## User/project inheritance

User settings provide defaults. Project settings override fields for matching keys; user-only entries still apply unless overridden.

For example, user config `{ "active": true, "serviceTier": "flex" }` and project config `{ "active": true }` produce an active `flex` entry. The project is inheriting a tier explicitly selected by the user, not an implicit default.

A project `{ "active": false }` disables that model even if the user default is active. A user-level off does not disable an explicit project-level on. `unknownModelBehavior` and `statusFormat` use the same project-over-user precedence. An explicit empty project format hides normal status rather than inheriting the user's format.

The effective entry requires both `active === true` and a valid merged tier. Provider/API eligibility is an additional prerequisite; saved settings cannot override the [route block](providers.md#route-eligibility).

## Invalid entries versus invalid files

| Input | Result |
| --- | --- |
| No config file | Normal inheritance from the other scope. |
| Missing tier in both scopes | Effective off. |
| Invalid explicit tier in an entry | That scope's entry becomes inactive; it cannot revive a user tier. |
| Malformed per-model entry or explicit non-boolean `active` | That entry becomes inactive. |
| Read error, invalid JSON, or invalid whole-file schema | Tier application/probes are suspended for the project, even if the other scope enables a tier. |

Whole-file errors include a non-object root, a non-object `entries` value, invalid/unsupported schema versions, invalid unknown-behavior values, and malformed `statusFormat` templates. An empty object or omitted `entries` remains valid for compatibility with older/partial configs. A dangling symlink is unreadable config, not an absent file.

Per-model normalization retains valid model keys and unrelated valid entries. Whole-file errors are not normalized into empty defaults.

## Recovery and refresh

When a whole-file error occurs:

1. The status shows `service_tier ○ off (config error)`; commands/request checks identify the affected path without printing file contents.
2. Existing invalid files are preserved. Startup migration and package command writes are deferred while either settings scope has an error.
3. Repair the file manually or move it aside, then retry the command/request. A package tier command will not overwrite a broken file to repair it.

Moving a file aside makes it absent, which can restore a valid setting inherited from the other scope. Check the effective status before sending requests if you want the tier to remain off.

Config is re-read before provider requests and by ongoing probe guards. A manual off/error edit stops new tier injection and cancels an ongoing probe without requiring `/reload`. Probe cancellation cannot undo charges for a request already processed by the provider.

## Migration and file I/O

At extension startup, existing user settings, the current project's settings, and the shared support map are checked for retired preset data, even if the selected route is blocked. A settings-scope error defers all cleanup. Files that were actually cleaned trigger one `[pi-provider-service-tier v<version>]` informational notice showing the installed package version and explaining provider/OAuth/API differences and manual/Probe verification; sessions with nothing removed show no such notice.

Cleanup removes preset containers/metadata, preset-only support records (including legacy/preserved copies), and preset documentation in mixed records. Explicit `active`/`serviceTier` selections, valid inheritance, unrelated settings, manual facts, and prepared Probe evidence/observations are retained. Cleanup never starts a probe, chooses a tier, or disables an otherwise valid active setting. A removed preset may change the support label to `unknown`, while the tier continues to be sent.

Support varies by provider, model, account, OAuth versus API-key access, and API route. Even an identical provider/model key does not mean identical supported `service_tier` values. Confirm support for the current environment manually or with an explicitly approved Auto Probe. Support records are scoped by provider/model/API **and OAuth/API-key mode**, while activation settings deliberately remain provider/model-scoped. Pi's non-secret registry metadata supplies the current mode; no tokens or keys are inspected or stored. A detected mode change uses that mode's records (or `unknown`), warns that healthy explicit tier settings remain active, and invalidates running probes, stale prompts, cached support, and request-error tracking. It never initiates probing by itself. Different accounts within the same mode still need user confirmation; see [evidence limitations](support-and-probes.md#known-evidence-limitations).

Normal default-file initialization and structural migration still wait for an allowed route and healthy settings. Settings remain v2; the support map migrates forward from v1/v2 to v3 at the same filename. Already-v3 API-only records are normalized into `auth.unknown` without guessing which historical login/key produced them. Original manual facts, Probe evidence/observations, and user marks remain in that unclassified slot but cannot establish current support or suppress its prompts. New records use explicit `auth.oauth` / `auth.api_key` slots. There is no downgrade conversion or compatibility saving. The old `unsupportedModelBehavior` name is accepted for settings migration, and obsolete `aggressiveProbe` is dropped.

Support-map upgrades tolerate minor metadata issues, retain unclassifiable records, attempt an optional original-byte backup, and replace files safely. Real read/JSON/future-version/write failures preserve the map instead of resetting it. Unlike a settings-file error, a support-map error does not disable a healthy explicit tier. See [support-map migration](support-and-probes.md#forward-migration-and-file-safety).

Developer-facing behavior:

- `readConfig()` returns `undefined` only for an absent file; config errors throw `ConfigFileError`.
- Effective resolution carries errors in `configIssues` and returns inactive tier state instead of allowing cross-scope fallback.
- Config writes reject existing invalid files. Default-file creation is exclusive so a newly appeared file is not overwritten.
- Historical blocked-provider settings and non-preset records are retained and cannot bypass eligibility guards. Preset retirement applies to blocked routes too.
- Map writes use exclusive creation or same-directory temporary-file replacement, preserve symlinks, and check for concurrent changes before replacement. Preset cleanup of existing settings also uses same-directory temporary-file replacement, preserves symlinks, and checks for observed concurrent edits. Ordinary settings writes retain their existing validation and missing-file safeguards.
