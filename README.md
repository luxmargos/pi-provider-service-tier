# pi-provider-service-tier

[![npm version](https://img.shields.io/npm/v/pi-provider-service-tier.svg)](https://www.npmjs.com/package/pi-provider-service-tier)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org/)
[![Pi extension](https://img.shields.io/badge/Pi-extension-purple.svg)](https://github.com/luxmargos/pi-provider-service-tier)

Choose a provider's processing tier for individual models in Pi, with project-specific settings or user-wide defaults. Your prompts, tools, and selected model stay unchanged.

**Paid tiers can cost more, and faster responses are not guaranteed.** Availability depends on your provider, model, and account; a green status or successful probe does not confirm the tier actually served.

## Quick start

Requires Pi `>=1.1.0` and Node.js `>=22.19.0`.

```bash
pi install npm:pi-provider-service-tier
```

Inside Pi, select a supported provider/model, then:

```text
/reload
/fast-project on
/fast-project status
```

Fast mode explicitly selects `priority`. To disable it for this model in this project:

```text
/fast-project off
```

If an unknown-support prompt appears, choose **Leave unknown once** to avoid a paid probe. This leaves your selected tier enabled; it does not turn the tier off.

For a project-local installation, add `-l` to `pi install`. Alternatively, install from GitHub:

```bash
pi install git:github.com/luxmargos/pi-provider-service-tier
```

Use `/reload` after installing or updating. To inspect or remove an npm installation:

```bash
pi list
pi remove npm:pi-provider-service-tier
```

For other installation sources, remove the source shown by `pi list`; add `-l` for a project-local installation.

## Provider availability

| Pi provider | What to know |
| --- | --- |
| `openai` | Tier availability varies by model and authentication method. |
| `openai-codex` | Legacy ChatGPT route; do not assume public API-key support applies. |
| `openrouter` | Tier availability and fallback depend on routing. |
| `xai` | Priority availability is model/account-dependent. |
| `groq` | The package currently covers `auto` and `flex`, not every Groq tier. |

Native **Anthropic, Gemini/Vertex, and AWS Bedrock** are currently blocked, as are unlisted providers and unsupported API routes. This only disables the extension's features; normal Pi requests remain usable and saved settings are retained. Models accessed through OpenRouter follow OpenRouter's rules.

There are **no bundled support presets**. Even the same provider/model can accept different `service_tier` values depending on OAuth login, API-key access, or API route. Select values yourself and verify support for your current environment manually or through an explicitly approved Probe. The extension automatically distinguishes Pi-managed OAuth/API-key authentication and keeps their support records separate; old records with no authentication scope remain unclassified, not reused.

At startup, old preset information is removed from the current project's settings, user settings, and support map. Actual removal produces a `[pi-provider-service-tier v<version>]` informational notice identifying the installed extension version and explaining why. Explicit tier choices and manual/Probe records stay; cleanup does not turn tiers off or start probes.

See [provider details](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/providers.md) for exact routes, authentication cautions, and official references.

## Choose a tier and scope

Each tier command applies to the **currently selected provider/model**, not every model.

| Command | Purpose |
| --- | --- |
| `/service-tier-project`, `/service-tier-user` | Open a tier picker with support symbols and a legend. |
| `/service-tier-project <tier>` | Select a tier for this model in this project. |
| `/service-tier-user <tier>` | Select a user-wide default for this model. |
| `/service-tier-project off` | Disable it in this project. |
| `/service-tier-user off` | Disable the user-wide setting. |
| `/service-tier-project status` | Show project and effective settings. |
| `/service-tier-user status` | Show user and effective settings. |
| `/fast-project [on\|off\|status]` | Priority shortcut; no argument toggles it. |
| `/fast-user [on\|off\|status]` | User-wide priority shortcut. |
| `/service-tier-status-format <format\|reset\|status>` | Customize the footer in user settings, or remove its user override. |
| `/service-tier-status-preset <minimal\|medium\|long\|status>` | Quickly save a footer template; `minimal (default)` is the default preset. |

`/service-tier-fast-project` and `/service-tier-fast-user` are the full-name equivalents of `/fast-project` and `/fast-user`. Argument completion is available with Tab.

Tier options in `/service-tier-project` and `/service-tier-user` start with `service_tier: `; `off` and `status` do not. The picker distinguishes `✓` Probe-verified, `?` unverified, `↪` fallback, `✕` rejected, and `✎` manual records for the current model/API/authentication mode. **All tiers remain selectable**; symbols describe saved evidence, not a future guarantee. Opening or cancelling does not probe or write settings; choosing a tier follows your existing [support-check policy](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/support-and-probes.md#unknown-support-policy) and may start paid Auto Probe. `○ off` and `ℹ status` are also available.

Selectable values: `priority`, `fast`, `ultrafast`, `flex`, `default`, `auto`, `scale`. **Not every provider/model accepts every value.** `default` and `auto` still request a tier; use `off` to stop this extension adding one.

Project settings override matching user settings. A user-wide `off` does not override an active project setting; use project `off` to disable it there. No valid configured tier means off—there is no automatic `priority` selection.

Examples:

```text
/service-tier-project flex
/service-tier-user priority
```

`ultrafast` is a separate, higher-priced OpenAI tier, not another name for priority. Check [OpenAI's guide](https://developers.openai.com/api/docs/guides/ultrafast-mode), current account/model eligibility, and pricing before enabling it; the extension supplies no preset approval.

## Read the status

Notifications, dialog titles, and command descriptions identify `pi-provider-service-tier`. Routine updates use **Info**, conditions needing attention use **Warning**, and failed requests or operations use **Error**. Choice/argument-completion labels and footer status intentionally stay compact, without the extension name.

| Display | Meaning |
| --- | --- |
| `service_tier: ○ off` | No tier is being added by this extension. |
| `service_tier: ⚡ <tier>` | Priority, fast, or ultrafast is enabled. |
| `service_tier: ● <tier>` | Another tier is enabled. |
| `unknown` in `{support}` | Stored support information is inconclusive; the configured tier is still sent. |
| `service_tier ○ off (config error)` | A settings file needs repair; tier application is suspended. |
| No indicator | This provider/API route is blocked. |

Customize the footer, for example with `/service-tier-status-format {symbol} {tier}{" | "support}`. The optional `statusFormat` field lives in the existing extension JSON; no default format/file is created at startup. Use `reset` to remove the user override or `status` to inspect it. See [format tokens and file details](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/configuration.md#footer-format).

For a quick length change, use `/service-tier-status-preset minimal` for `service_tier: ⚡ priority`, `medium` for `service_tier: ⚡ priority | fallback`, or `long` for `service_tier: ⚡ priority | fallback → default` in this example. All presets save a template through the format command and preserve project precedence. Argument completion labels `minimal (default)` while inserting `minimal`; settings without a format use that same minimal template without writing it to disk. Format `reset` removes the user override, restoring minimal unless a project format takes precedence.

The format controls the entire normal footer, including `service_tier:`. For example, `/service-tier-status-format Tier: {symbol} {tier}{" | "support}{" → "fallback}` displays `Tier: ⚡ priority | fallback → default` when that fallback evidence is saved, `Tier: ⚡ priority | manual` with manual evidence, or `Tier: ○ off` when off. `{label}` inserts `service_tier`; replace it with your own text or omit it to change/remove the prefix. `{support}` shows `fallback` for a tier mismatch; `{fallback}` supplies the reported tier, such as `default`, and is empty otherwise. In `{" | "support}`, the quoted prefix (including spaces) appears only with a nonempty segment.

Evidence labels are shown by `medium`, `long`, or a custom format with `{support}`; the default minimal preset omits them. `manual` means user-maintained support, not a live check. Green `probe-verified` means a prior completed probe reported the expected tier; `probe-completed (tier unknown)` and `fallback` are not positive verification. None guarantees future delivery, billing, or speed. Medium and long use conditional prefixes to avoid dangling separators. Existing saved templates are preserved; reapply a preset to adopt the improved format. Separators outside tokens, such as ` | {support}`, remain literal for compatibility.

## Support checks and costs

By default, `ask` offers an Auto Probe or a choice to leave unknown support unresolved after relevant commands. **Auto Probe sends low-token requests for provider/API-specific candidates, including paid tiers such as ultrafast on OpenAI; it is not free.** Choosing **Always auto-probe** also enables future cycles after tier/fast commands, even when support is already recorded.

To avoid automatic probes and support prompts:

```text
/service-tier-unknown-behavior leave-unknown
```

The other options are `ask`, `auto-probe`, and `status`. This changes the user-wide support-check policy, not the selected tier.

Tier/fast off commands cancel running probes and stop subsequent probe requests. Already received or processed requests may still be billed. Cancelled or late results are not saved.

Optional support maintenance:

| Commands | Purpose |
| --- | --- |
| `/service-tier-unset-support`, `/service-tier-unset-support-all` | Forget the current API/auth record or all eligible known-auth records. Preserve unclassified history; do not disable tiers or call providers. |

## Troubleshooting

- **Changed authentication:** OAuth/API-key support is separate. A detected mode change warns, refreshes support status, and cancels stale probes/prompts without changing tier settings or starting a Probe. Different accounts/keys within the same mode are not distinguished; re-confirm support or unset it before an explicitly approved fresh Probe.
- **Tier rejected:** use `/service-tier-project off` or select a different tier. Failed requests are not retried automatically; rejection does not turn the configured tier off.
- **No speed improvement:** the provider may ignore the tier or use a fallback. Completion and status alone cannot verify delivery; check provider-side usage/billing information.
- **Config error:** repair the file named in the error notification, or move it aside and retry. The extension preserves broken files rather than replacing them. A missing file allows normal user/project inheritance.
- **Support-map error:** repair or move aside the named map. Support becomes unknown, but healthy explicit tier settings remain active.
- **Unsure whether a tier is sent:** enable `/service-tier-debug on`, make a request, then use `/service-tier-debug off`. This reports the extension's decision, not the server's processing tier.

For file locations, manual settings, and recovery details, see [configuration](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/configuration.md).

## Further reading

- [Provider/API and authentication reference](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/providers.md)
- [Support records, probes, and known limitations](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/support-and-probes.md)
- [Development and offline verification](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/development.md)
- [Latency benchmarking — makes real provider calls](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/benchmarking.md)
- [Fast-mode research — Pi packages and external implementations](https://github.com/luxmargos/pi-provider-service-tier/blob/main/docs/fast-mode-research.md)

## License

MIT
