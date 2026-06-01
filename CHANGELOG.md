# Changelog

All notable changes to SpecRider are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-01

### Fixed

- Show the correct app version in the up-to-date dialog (#15).

### Security

- Bump Tauri to 2.11.2 to address the IPC origin-confusion advisory.
- Replace the unsound `serde_yml` with `serde_yaml_ng`.

### Changed

- Add `--force` flag when running `dev` to resolve outdated deps.
- Add a dmg notarization helper script.
- Add Dependabot version-update configuration.
- Routine dependency updates for Cargo, mermaid, tar, and GitHub Actions.

## [0.1.0] - 2026-05-30

### Added

- Initial public release of SpecRider — a workspace for spec-driven development with Git-backed Markdown specs as the source of truth for humans and agents.

[0.1.1]: https://github.com/specrider/specrider/releases/tag/v0.1.1
[0.1.0]: https://github.com/specrider/specrider/releases/tag/v0.1.0
