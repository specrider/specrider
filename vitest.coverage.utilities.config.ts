import {
  defineCoverageConfig,
  utilityCoverageInclude,
} from "./vitest.coverage.shared";

export default defineCoverageConfig({
  coverageInclude: utilityCoverageInclude,
  reportsDirectory: "coverage/utilities",
  thresholds: {
    statements: 30,
    branches: 25,
    functions: 30,
    lines: 30,
  },
});
