import {
  componentCoverageInclude,
  defineCoverageConfig,
} from "./vitest.coverage.shared";

export default defineCoverageConfig({
  coverageInclude: componentCoverageInclude,
  reportsDirectory: "coverage/components",
  thresholds: {
    statements: 55,
    branches: 50,
    functions: 58,
    lines: 58,
  },
});
