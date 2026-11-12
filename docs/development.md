# Development and verification

[User guide](../README.md) · [Configuration](configuration.md) · [Provider/API reference](providers.md) · [Benchmarking](benchmarking.md)

Follow [AGENTIC_AI_CHECKLIST.md](https://github.com/luxmargos/pi-provider-service-tier/blob/main/AGENTIC_AI_CHECKLIST.md) before changing or releasing the package. Keep task progress outside that policy file.

## Local setup

Requires Node.js `>=22.19.0`. Development references for `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are pinned to exactly `1.1.0`. Their peers remain `"*"` because Pi supplies them at runtime; do not bundle a competing host runtime.

```bash
git clone https://github.com/luxmargos/pi-provider-service-tier.git
cd pi-provider-service-tier
npm install
npm run check
```

`npm install` is a dependency installation step, not part of offline verification of an already prepared checkout.

## Package layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Extension factory, settings validation/I/O, commands, lifecycle hooks, payload injection, probe orchestration. |
| `src/service-tiers.ts` | Shared tier values, eligibility, key parsing, and exact route identity. |
| `src/support-map.ts` | v3 support schema, tolerant migration, safe persistence, and route-scoped evidence operations. |
| `src/probe-evidence.ts` | Provider-specific candidates and served-tier parsing/comparison. |
| `src/*.test.ts` | Pure-function, mocked integration/I/O, and offline real-SDK serialization tests. |
| `src/legacy-presets.ts` | Pure retirement-only cleanup of old preset data; no support seeding or lookup. |
| `src/auth-scope.ts` | Non-secret Pi auth-mode detection and exact provider/model/API/auth matching. |
| `src/extension-ui.ts` | Shared extension-name formatting and notification delivery; footer status and choice labels are deliberately excluded. |
| `src/tier-picker.ts` | Pure, non-mutating tier labels and legend from existing scoped evidence; no I/O or provider calls. |
| `src/status-format.ts` | Bounded single-line footer-template validation and safe non-recursive segment substitution. |
| `scripts/benchmark-service-tier.mjs` | Opt-in live latency comparison; tests run it only with a fake CLI. |
| `scripts/benchmark-observer.mjs` | Explicit benchmark-only factory: normal extension plus ordered, non-mutating observation, preparation/failure guards and no saved benchmark support evidence. Not the normal package entrypoint. |
| `scripts/benchmark-analysis.mjs` | Pure sidecar validation, privacy allowlists and descriptive paired/uncertainty analysis. |
| `docs/*.md` | Topic-specific user references and maintainer documentation. |

The Pi manifest loads `./src/index.ts`. The npm `files` allowlist includes the runtime source, scripts, docs, README, and CHANGELOG; no preset data. Review it whenever adding runtime modules or moving referenced documentation. Unit tests and local state are not published.

## Runtime design

- The default export receives `ExtensionAPI` and registers package commands/events. Import alone must not make model calls or write config.
- Notifications (including errors/debug/Probe results), dialog titles, command descriptions, and optional-backup warnings identify `pi-provider-service-tier` through the shared UI formatter. Existing name/version prefixes are not duplicated; preset retirement retains its installed-version label. Completion and dialog-choice labels intentionally omit the extension prefix; insertion values, existing Probe-approval choices, and shared Pi UI methods stay unchanged. Default footer/status text and Probe progress intentionally remain compact and unprefixed; optional `statusFormat` customizes only the normal footer.
- Eligibility is explicit provider **and** API identity, checked before interaction/injection and again for resolved probe requests. Native adapters require distinct serializers/candidates; see [provider contracts](providers.md#why-native-routes-remain-blocked).
- Config helpers separate normalization and effective resolution from command/UI side effects. Whole-file errors remain distinct from missing files; read-only request checks must not reset broken config.
- `before_provider_request` returns a copied payload only for an eligible, explicitly active valid tier. Otherwise it returns `undefined` and clears injection tracking. Shared payloads are not mutated or stripped of unrelated fields.
- `message_end` records recognized tier errors only for tracked extension injection, without retrying the failed request.
- Startup scans existing settings/maps for preset retirement with healthy config, including on blocked routes; notify only after an actual successful removal with the package-name/version prefix (with the version read from the installed `package.json`) and OAuth/API caution. Normal default initialization waits for an eligible route. Support maintenance preserves non-preset blocked records.
- Auto Probe uses the configured model registry, not direct provider/auth resolution. Per-instance ownership, generation checks, and abort controllers prevent stale prompts/results from surviving off, model changes, or shutdown.

The support map is advisory, not an activation gate. `src/service-tiers.ts` owns shared tiers/route identity, `src/support-map.ts` owns v3 migration, persistence, and route-scoped knowledge, and `src/probe-evidence.ts` owns candidates/response semantics. Support-map v3 API routes contain independent `auth.oauth`, `auth.api_key`, and unclassified `auth.unknown` slots; unknown is never a lookup fallback. Existing API-only records migrate to unknown without inferring today's authentication. Settings remain v2 and provider/model-scoped. A mode transition invalidates owned probes/prompts, caches and request tracking, without selecting a tier, turning it off, or initiating a Probe. Auth detection uses synchronous `hasConfiguredAuth()`, `getProviderAuthStatus()`, and `isUsingOAuth()` metadata; it does not resolve keys, refresh tokens, read auth files, or make network calls. SDK completion alone cannot create positive evidence. Provider metadata and a prior observation still do not prove future application or billing; see [known limitations](support-and-probes.md#known-evidence-limitations).

## Tier picker

Bare project/user tier commands use native `ctx.ui.select()` when `ctx.hasUI` is true (TUI/RPC); headless calls retain status behavior. Read existing config/map data before showing the dialog without initializing/migrating files. The pure picker module uses existing evidence lookup/normalization and preserves every raw selectable tier plus off/status; symbols are presentation, not activation gates or automatic probes. Tier option/completion labels start with `service_tier: `, while off/status retain their utility labels; inserted values remain raw. See the [legend and user contract](support-and-probes.md#tier-picker).

Resolve the returned label through the offered choice objects, never by parsing arbitrary UI strings. After the asynchronous dialog, recheck the owner/generation, exact route, auth-mode snapshot (including unchanged unknown mode), project paths, and healthy settings snapshot before applying the choice. Discard observed stale choices, including switch-away/back events, without reviving a cancelled Probe or overwriting external settings changes. Current-schema map lookup, cancellation, payload immutability, explicit arguments, approved paid-Probe policy, and compact footer formatting remain unchanged.

## Footer templates

Store optional `statusFormat` in existing v2 settings with project-over-user precedence; never materialize a default property/file at startup. Validate templates as part of whole-file schema safety. Missing values render the shared default minimal template, empty values hide normal status, and config-error/blocked-route guards take precedence. Apply verified-only coloring after substitution, not through user-provided ANSI. Re-read formats with config and refresh on a changed format even when the tier is unchanged. The user formatter command uses read-only map lookup; healthy formatting-only changes do not start/cancel probes or replace their temporary progress. Config/I/O failures retain the existing cancellation guards. See [the syntax and command contract](configuration.md#footer-format).

Keep `/service-tier-status-preset` a thin wrapper over that handler: every preset saves a template, and no separate preset state is stored. Define the default through the minimal preset in the pure formatting module; argument completion labels it `minimal (default)` without changing insertion values. Derive command help and descriptions from the same default constant. In templates, fallback evidence uses `{support}` = `fallback` and `{fallback}` = the saved reported tier; other states leave `{fallback}` empty. Preserve evidence/verified-color semantics. Medium/long use quoted conditional prefixes `{" | "support}` and `{" → "fallback}`; minimal stays the default. Share one bounded parser between validation and rendering: prefixes are JSON strings, decoded controls are invalid, and only known tokens are accepted. Omit a quoted prefix together with an empty/whitespace-only token after sanitization and bounding; keep ordinary tokens, escaped braces, literal spacing, and existing saved formats unchanged. Never recursively interpret prefix or segment text.

## Notification severity

Use Pi's native `info`, `warning`, and `error` levels according to the outcome, not a blanket warning or text-based classifier. Call sites choose the level; the shared UI formatter preserves it.

| Level | Use |
| --- | --- |
| `info` | Successful preset retirement, settings/status/debug updates, user cancellation, and approved Probe start/normal completion. Completion alone is still not tier verification. |
| `warning` | Authentication changes or unknown authentication needing confirmation, incomplete probes, a probed selected tier being rejected, or enabling a tier already recorded as rejected while requests will still send it. Rejections of other Probe candidates are normal results, not failures of the selected tier. |
| `error` | Invalid/blocked commands, config/map I/O or validation failures, Probe execution exceptions, and actual configured requests rejected for their tier. |

Changing severity must not change activation, support evidence, Probe approval/cost disclosures, retries, payloads, name/version prefixes, or compact footer/Probe-progress text. Optional backup failures remain warnings because file replacement can still succeed.

## Offline checks

```bash
npm run check
for script in scripts/*.mjs; do node --check "$script"; done
git diff --check
```

`npm run check` runs:

1. `tsc --noEmit`.
2. All `src/*.test.ts` Node tests with TypeScript stripping: extension regressions, migration/I/O faults, evidence semantics, and real Pi SDK serializers using locally mocked HTTP responses; no paid model calls.
3. `npm pack --dry-run`, including documentation/publication contents.

Benchmark regressions cover all existing profile budgets/orders offline, identical paired CLI prompt arguments, missing/stale/inconsistent observations, normal-versus-incomplete completion, metadata conflicts, usage/secret exclusion, fixed-output validation, partial failures and descriptive paired analysis. The benchmark observer registers completion/failure handling **before** the ordinary extension's rejection persistence, and payload observation **after** its tier injection. Preserve both orderings. It uses a private case contract, never mutates shared events, and cannot treat hook counts as a wire/billing cap.

`prepublishOnly` runs the same check, but publication is a separate explicitly authorized action.

For runtime changes, practical smoke coverage should load the TypeScript entrypoint through Pi 1.1.0's extension loader with isolated temporary config, fake UI/registry, and forbidden network access. Exercise commands/events, unchanged payloads, preset cleanup/notification idempotence, explicit/manual/Probe preservation, OAuth/API-key isolation, unknown-auth history, auth-change warnings/stale prompts, original-file preservation, cancellation signals, late responses, and per-instance isolation. Restore temporary environment changes afterward. A mocked stream verifies local behavior, not account eligibility or served tiers. Real-CLI benchmark mocks must additionally deny network at the OS level and use isolated fake credentials/settings: bundled CLI initialization can replace global `fetch`, so a JavaScript interceptor alone is not containment. Do not consume/reuse prior live-run authorizations or locks to verify benchmark changes.

## Interactive local loading

For a prepared checkout:

```bash
pi -e . --provider openai --model gpt-5.5
```

Or install the checkout project-locally with `pi install -l .`, then `/reload`. Do not simultaneously load the same checkout with `pi -e .`; duplicate registrations can receive numeric command suffixes. Remove the local install with `pi remove -l .`.

Loading alone does not start Auto Probe. Sending a prompt, enabling automatic probing, or running a live benchmark can make paid requests and needs explicit authorization. Keep verification offline by default; do not resume cancelled live checks implicitly.
