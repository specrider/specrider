import {
  allCoverageInclude,
  defineCoverageConfig,
} from "./vitest.coverage.shared";

// Separate config from vite.config.ts so the test runner stays
// independent of the dev/Tauri server settings. The `tests/` directory
// holds Playwright specs (perf.spec.ts) which run via `pnpm test:perf`
// — exclude them so vitest doesn't try to load them.
export default defineCoverageConfig({
  coverageInclude: allCoverageInclude,
  reportsDirectory: "coverage/all",
  thresholds: {
    statements: 30,
    branches: 25,
    functions: 30,
    lines: 30,
  },
});
