# Changelog

Notable changes to this package are documented here.

## Unreleased

### Added

- Added quoted conditional prefix tokens such as `{" | "support}` and `{" → "fallback}`. Render the prefix only with a nonempty sanitized segment; validate JSON escapes and reject decoded controls while preserving ordinary tokens and literal brace escaping.
- Added `/service-tier-status-preset minimal|medium|long` as a user-format wrapper with argument completion; all presets save explicit templates, and minimal is shared with the default formatter. Label minimal as `minimal (default)` while preserving its raw insertion value. Added `{fallback}` for the saved reported fallback tier, empty in other states.
- Added an opt-in `PST_BENCH_WORKLOAD=fixed` exact-sequence task for supplementary output-controlled comparisons; existing benchmark profiles, default model/workloads and call budgets are unchanged.
- Added `bench:service-tier:stress:light`: two alternating measured pairs, no warmup, medium thinking, and a shorter memo with a 2,500-character minimum (four Pi completions rather than stress's twelve).
- Added optional `statusFormat` footer templates in existing user/project JSON with `{label}`, `{symbol}`, `{tier}`, and `{support}` segments, lazy explicit user saves via `/service-tier-status-format`, reset/status actions, safe validation, and preserved error/Probe-progress behavior. Formatting does not change tier activation, support evidence, or Probe policy.
- Added a symbol-labelled tier picker and inline legend to bare `/service-tier-project` and `/service-tier-user` commands. Distinguish prepared Probe verification, unverified/completion-only, fallback, explicit rejection, and manual records for the exact route/auth mode, while keeping all tiers selectable. Opening/cancelling is read-only and never probes; selection preserves existing approval policy, raw tier values, and off/status actions. Discard stale selections after observed context/settings changes; retain headless status and compact footer behavior.
- Added the documented OpenAI `ultrafast` service tier and the `fast` alias across config validation, commands, completions, status, and full auto-probe cycles.
- Added topic-specific configuration, provider/API, support/probe, development, and benchmarking references under `docs/`, included them in the package, and shortened README to practical user guidance.

### Changed

- Use conditional evidence prefixes in medium/long footer presets to hide empty separators: ` | ` before support and ` → ` before the reported fallback tier. Minimal remains the default; existing saved templates keep their literal behavior until explicitly changed or a preset is reapplied.
- Include the `service_tier:` label in the minimal and medium footer presets, matching long. Existing saved/custom formats and project precedence remain unchanged; reapply a preset to save its updated template.
- Use the minimal template (`{label}: {symbol} {tier}`) for normal footer status when no format is configured; existing saved formats remain unchanged. In evidence-enabled templates, show `fallback` in `{support}` and expose the reported tier separately through `{fallback}`. Templates replace the entire normal footer, allowing a custom or omitted `service_tier:` prefix, while separators outside conditional tokens remain literal text even beside empty segments.
- Harden benchmark evidence with a benchmark-only Pi observer: distinguish prepared payload tier/effort/cap, actual runtime versions, HTTP response callbacks, streaming text, normal completion, usage and reported tier without treating hooks as a wire capture or saving observations/rejections as support evidence. Stop missing/inconsistent or changed-scope measurements, additional preparations, invalid output and failures without retry/replacement cases; stop cache warming and use temporary leave-unknown policy.
- Use identical prompts/scenario/nonces within each benchmark pair, report paired dispersion, separate streaming/total win counts, order splits, output/cache/reasoning workload and exploratory bootstrap uncertainty. Interpret the practical threshold using paired mean total CLI time only, retain `generationMs` as a deprecated residual-time alias, and remove generated-output/stderr tails from reports.
- Prefix tier selection and argument-completion labels for `/service-tier-project` and `/service-tier-user` with `service_tier: `, excluding off/status and preserving raw insertion values and extension-name-free option labels.
- Match TUI notification severity to the outcome: informational preset retirement and approved Probe lifecycle updates, warnings for incomplete checks or a selected tier being rejected, and errors for actual configured-request failures. Keep authentication cautions and all activation/Probe approval behavior unchanged.
- Identify `pi-provider-service-tier` in non-footer TUI notifications, errors, dialog titles, command descriptions, and optional-backup warnings. Preserve the versioned preset-removal notice, keep command argument-completion/dialog-option labels free of the extension-name prefix, and leave compact footer/status/probe-progress text unchanged.
- Pinned Pi AI and coding-agent development references to 1.1.0, regenerated the lockfile, and aligned the Node.js minimum to 22.19.0; Pi-supplied peer dependencies remain `"*"`.
- Removed the entire bundled preset system, provider-wide support assumptions, automatic seeding/startup refresh, and `/service-tier-refresh-support` / `/service-tier-refresh-support-all`. Users select tiers and maintain support information manually or through explicitly approved Auto Probe.
- At startup, retire preset metadata from both settings scopes and preset-only/documented support from the shared map, including old blocked-provider presets and mixed records. Notify only after actual removal with `[pi-provider-service-tier v<version>]` using the installed package version, the provider/OAuth/API rationale, and manual/Probe guidance; explicit tier choices, unrelated settings, and manual/prepared Probe evidence remain.
- Warn that identical provider/model identities can have different `service_tier` support under OAuth, API-key access, or different APIs. Support records now use independent provider/model/API/OAuth-or-API-key slots while explicit activation settings remain unchanged. Old API-only records move to unclassified `auth.unknown` without assigning a login; their manual/Probe history is retained, not reused as current support. Detected auth-mode changes warn and invalidate stale probes/prompts, caches, and error tracking, without starting new probes. Account/key changes within one mode still require user confirmation.
- Auto-probes now use Pi's configured model registry for provider routing, authentication, and context normalization. Positive verification requires both a prepared tier and matching provider-reported processing-tier metadata after terminal SDK completion.
- Migrated support maps forward to v3 with independent provider/model/API records at the existing filename; settings remain v2. Partial historical metadata is normalized, unclassified data is preserved, and safe replacement/optional original-byte backups avoid unnecessary upgrade failures. Downgrade compatibility is not implemented.
- Added provider/API-specific probe candidates and per-tier manual/legacy/verified/rejected evidence plus completion-only/fallback observations. Status distinguishes user-maintained support from prior probe verification, and missing served-tier metadata remains unverified.
- Expanded the latency benchmark into paired warmup/measured runs with alternating order, first-output timing, paired deltas, win counts, practical-threshold interpretation, and quick/stress npm scripts.
- Changed the benchmark default to `openai/gpt-6.1-sol` and explicitly pass it with `--model` in every npm benchmark profile, preserving environment overrides and validating arguments before Pi starts. Validate tier overrides against the shared tier list and label results with the selected tier.
- Disable automatic catalog network, retries, and compaction in the benchmark's owned temporary project. Clarify that Pi 1.1 print-mode first stdout is final-text emission, not first-token latency or proof of the applied processing tier.
- Restricted service-tier features to an explicit provider/API allowlist: OpenAI, legacy Codex, OpenRouter, xAI, and Groq routes. Native Anthropic, Google/Gemini/Vertex, Bedrock, unlisted providers, and mismatched APIs are blocked even with active manual config or saved probe records.
- Disabled package commands/aliases, completions, support prompts, probes, status, and injection on blocked routes. Normal Pi model requests remain available; saved settings and non-preset map entries are retained and all-model support maintenance skips blocked entries. Preset retirement scans existing files even on blocked routes.
- Deferred config/map initialization until an allowed route is selected and stopped in-progress probe cycles from continuing or saving results after their selected target changes.
- Rejected unlisted benchmark providers before starting Pi, documented current native-provider exclusions in README, and expanded TODO with provider-specific restoration work.

### Fixed

- Combine benchmark workload, scenario, and run metadata into one CLI message so each case makes one completion rather than separate follow-up requests. Preserve custom file attachments and stop option parsing before prompt text.
- Removed the implicit `priority` default: missing tiers stay off, and invalid explicit tiers/entries disable injection without reviving user tiers through project overrides. Status uses the validated effective tier; fast commands still explicitly select `priority`.
- Cleared stale injection tracking on requests this extension leaves unchanged, preventing unrelated tier errors from corrupting the support map after switching off.
- Distinguished absent project/user config from read, JSON, and whole-schema errors. Errors suspend tier injection/probes without falling back to another scope; existing invalid files, unrelated config, and support records remain untouched by initialization or package commands. Request-time checks re-read config instead of retaining a cached paid tier.
- Cancelled active auto-probes on tier/fast off commands, off toggles, model changes, session shutdown, and manual off/error edits. Cancellation propagates to the SDK stream, stops subsequent tiers, invalidates outstanding support prompts, and prevents partial or late results from being saved; cancellation is isolated per extension instance.
- Kept other confirmed tier knowledge when a user leaves an unlisted tier unknown, and avoided repeatedly prompting for preserved user-marked entries.
- Prevented stored support, prompt suppression, maintenance, and request errors from crossing APIs for the same provider/model. Historical acceptance-only probes are retained without being promoted to applied-tier verification; map errors preserve data without disabling healthy explicit settings.
- Corrected tier-command/Probe documentation to disclose paid unknown-behavior evaluation; startup cleanup and support unsetting do not probe.

## [0.1.7] - 2026-06-29

### Added

- Added service-tier v2 config and support-map handling with determined support entries, probe results, user-marked unknown entries, and startup migration.
- Added support refresh and unset commands for current-model and all-model support-map maintenance.
- Added user-global unknown-behavior controls with `ask`, `auto-probe`, and `leave-unknown` modes.
- Added background auto-probe progress updates and prompt text that warns about possible provider token use.
- Added request-injection debug notifications for troubleshooting.
- Added a latency benchmark script for comparing baseline requests with service-tier requests.

### Changed

- Request-time injection now follows the active project/user configuration even when support-map knowledge is unknown or negative.
- Auto-probe now checks every known service tier in one cycle and writes one complete `source: "probe"` entry only when every tier is determined.
- Unknown-behavior option names were clarified from the older aggressive/unknown wording to `auto-probe` and `leave-unknown`.
- Floating status text now omits provider/model details, keeps status visible when off, and uses simple off/priority/active indicators.
- README guidance now reflects the current commands, config schema, support-map behavior, and request-time injection behavior.

### Fixed

- Preserved completed probe entries when explicit tier or fast commands target tiers already known in `tiers` or `unsupportedTiers`.
- Avoided overwriting support maps with partial auto-probe results when any tier remains unknown.
- Kept auto-probe work in the background so user requests continue using the current active configuration.
- Recorded provider service-tier errors without retrying failed requests.

## [0.1.6] - 2026-05-26

### Changed

- Renamed the npm package to the unscoped `pi-provider-service-tier` package identity.
- Updated package metadata for the `0.1.6` release.

[0.1.7]: https://github.com/luxmargos/pi-provider-service-tier/compare/0.1.6...0.1.7
[0.1.6]: https://github.com/luxmargos/pi-provider-service-tier/compare/0.1.5...0.1.6
