# Testing Guide

SpecRider uses Vitest for frontend and TypeScript unit tests, React Testing Library for component behavior, and Rust unit tests with temporary directories or repositories for Tauri backend flows.

## Local Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm test:coverage:components
pnpm test:coverage:utilities
cargo test --manifest-path src-tauri/Cargo.toml
```

`pnpm test:coverage` reports all frontend source coverage into `coverage/all`. The component and utility commands write separate reports into `coverage/components` and `coverage/utilities`.

## Coverage Policy

Coverage thresholds start deliberately low to make CI useful without blocking normal refactors. Raise them by directory after new suites land, and prefer raising a focused slice before raising the all-source threshold.

Current frontend slices:

- All source: `src/**/*.{ts,tsx}`
- Components: `src/components/**/*.{ts,tsx}`
- Utilities/providers: `src/app`, `src/hooks`, `src/lib`, `src/markdown`, `src/pins`, `src/plans`, `src/search`, `src/settings`, and `src/tauri`

Rust coverage is not measured in CI yet. The backend gate is the focused Rust test suite, especially temp-repo tests around Git and filesystem behavior.

## Tauri Mocks

Mock the frontend Tauri bridge at `src/tauri/api.ts` instead of mocking `@tauri-apps/api` directly in component tests. Keep command-contract coverage close to `src/tauri/api.test.ts`; component tests should assert user-visible behavior and only inspect IPC calls when the call shape is the behavior.

Use `src/test/setup.ts` for shared DOM shims. Add global shims there only when multiple suites need them.

## React Providers

Provider tests should render a real provider with the narrowest consumer needed to observe state. Cover optimistic updates, event subscriptions, rollback paths, and context misuse errors at the provider boundary before adding broad app-level tests.

For settings, pins, and workspace hooks, prefer fake API functions and deterministic event emitters over timers hidden inside components.

## Temporary Git Repos

Backend Git tests should create a fresh `tempfile::TempDir`, run `git init`, configure `user.name` and `user.email`, and commit real files. This catches path handling, branch state, and Git error parsing that parser-only tests miss.

Keep network-free guard tests explicit. For push and pull flows, assert local errors such as protected main and no-upstream rather than contacting a remote.

## Async Race Tests

Use fake timers for debounce, autosave, and delayed analysis paths. Assert both the accepted result and the stale result that must be ignored. For worker fallbacks, cover the failed worker branch and the direct parser branch in the same suite so regressions are visible.

When a race depends on event ordering, make the test name describe the losing event, for example `ignores_stale_read_after_plan_switch`.
