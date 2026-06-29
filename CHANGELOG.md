# Changelog

Notable changes to this package are documented here.

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
