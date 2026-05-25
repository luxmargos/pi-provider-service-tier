# Agentic AI Checklist

This is a reusable, long-term policy checklist for agentic AI assistants working on this Pi extension package.

Do not use this file to track task progress. Do not mark, rewrite, or remove checklist items during normal implementation work. Track task-specific progress in a separate plan, issue, PR description, or final response.

## How to use this file

Before changing, reviewing, or releasing the package:

- Inspect the current source, tests, and docs before editing.
- Treat this file as stable guidance, not as an implementation map.
- Update this file only when the long-term development policy changes.

## 1. Pi extension/package fitness

Verify that the package remains compatible with Pi extension and package conventions:

- The package has a valid `package.json`.
- Pi resources are declared through a `pi` manifest or Pi convention directories.
- Published/package contents include every runtime file needed by the extension.
- The extension entrypoint exports a default factory that receives `ExtensionAPI`.
- Commands, hooks, tools, providers, or UI integrations are registered through Pi APIs.
- Module import has no unsafe side effects such as provider calls, network calls, package installs, or config writes.
- Runtime dependencies and peer dependencies are categorized intentionally.
- User-facing docs remain accurate when install, configuration, command, or runtime behavior changes.

## 2. Runtime behavior and safety

Verify that runtime behavior is predictable and safe:

- Hook handlers preserve Pi semantics and return “no change” when no modification is needed.
- Shared event objects are not mutated in place unless Pi explicitly documents that pattern.
- Behavior is scoped to the intended provider, model, project, user, or session boundary.
- Invalid config, unknown providers, unsupported models, and malformed data fail safely.
- Default behavior for unsupported or disabled cases is no-op, not risky fallback behavior.
- Secrets and sensitive payloads are not logged or exposed by default.
- Debug output is opt-in, minimal, and avoids API keys, auth headers, and full provider payloads.
- Provider probes, paid model calls, package installs, publishing, and remote mutations happen only when explicitly requested.

## 3. Modularity and reuse

Verify that changes keep the codebase maintainable:

- Pure validation and transformation logic is separated from Pi runtime/UI side effects where practical.
- File I/O, provider calls, command handlers, and hook registration remain easy to identify.
- Existing abstractions are reused before adding new ones.
- Key parsing, config merging, payload mutation, support detection, and notification patterns are not duplicated unnecessarily.
- New logic is testable without requiring a live Pi session whenever possible.
- Side-effectful wrappers stay thin around reusable core logic.
- Modules are extracted when complexity harms reviewability or blocks the requested change.
- Refactors are purposeful, not cosmetic.
- Public names, command names, config filenames, schemas, and package identity stay stable unless a breaking change is intentional.

## 4. Extensibility

Verify that future feature work remains easy and safe:

- Provider/model support is data-driven where possible.
- Provider-specific behavior is gated by current provider, model, configuration, and known support.
- Unknown or unsupported cases default to no-op.
- New config fields are optional or backward-compatible unless a migration is explicitly designed.
- Unknown config input is validated defensively.
- Existing user config is preserved where possible.
- New commands are discoverable, namespaced, and consistent with existing scope expectations.
- User-visible behavior changes are documented where users configure, install, or troubleshoot the extension.

## 5. Verification before handoff

For source changes, run the relevant project checks before handoff:

- Typecheck.
- Unit tests.
- Package dry-run or packaging verification.
- Full project check script, when available.

For documentation-only changes:

- Review markdown for clear, current, non-misleading guidance.
- Confirm no unintended source changes.

For runtime behavior changes, perform a manual Pi smoke test when practical:

- Load the extension locally.
- Exercise affected commands, hooks, or config paths.
- Confirm disabled, unsupported, or unknown cases behave as no-op.
- Restore any local test config changed during testing.

## 6. Agent workflow

Follow these working rules on every task:

- Preserve unrelated user changes.
- Make the smallest change that satisfies the request.
- Update tests or docs when behavior changes.
- Do not commit, tag, publish, install/remove packages, or make paid/remote provider calls unless explicitly asked.
- Final responses should summarize changed files and verification performed.

## 7. Maintaining this checklist

Keep this checklist useful over time:

- Prefer durable principles over current implementation details.
- Avoid naming specific functions, commands, files, providers, or test scripts unless the policy truly depends on them.
- Avoid duplicating detailed setup or usage documentation that belongs in README or Pi docs.
- Review this checklist when Pi extension conventions, package layout, or repository maintenance practices materially change.
