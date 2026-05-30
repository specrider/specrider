import { defineConfig } from "vitest/config";

const testInclude = ["src/**/*.{test,spec}.{ts,tsx}"];
const testExclude = ["tests/**", "node_modules/**", "dist/**", "src-tauri/**"];
const setupFiles = ["src/test/setup.ts"];

const coverageExclude = [
  "src/**/*.test.{ts,tsx}",
  "src/**/*.spec.{ts,tsx}",
  "src/test/**",
  "src/hooks/useTerminalSession.ts",
  "src/vite-env.d.ts",
];

const coverageReporter = ["text", "html", "lcov", "json-summary"];

type CoverageThresholds = {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
};

type CoverageConfigOptions = {
  coverageInclude: string[];
  reportsDirectory: string;
  thresholds: CoverageThresholds;
};

export const allCoverageInclude = ["src/**/*.{ts,tsx}"];

export const componentCoverageInclude = ["src/components/**/*.{ts,tsx}"];

export const utilityCoverageInclude = [
  "src/app/**/*.{ts,tsx}",
  "src/hooks/**/*.{ts,tsx}",
  "src/lib/**/*.{ts,tsx}",
  "src/markdown/**/*.{ts,tsx}",
  "src/pins/**/*.{ts,tsx}",
  "src/plans/**/*.{ts,tsx}",
  "src/search/**/*.{ts,tsx}",
  "src/settings/**/*.{ts,tsx}",
  "src/tauri/**/*.{ts,tsx}",
];

export function defineCoverageConfig(options: CoverageConfigOptions) {
  return defineConfig({
    test: {
      include: testInclude,
      exclude: testExclude,
      environment: "jsdom",
      setupFiles,
      globals: false,
      coverage: {
        provider: "v8",
        reporter: coverageReporter,
        reportsDirectory: options.reportsDirectory,
        include: options.coverageInclude,
        exclude: coverageExclude,
        thresholds: options.thresholds,
      },
    },
  });
}
