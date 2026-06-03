# Contributing to SpecRider

Thanks for considering a contribution. SpecRider is a small project; the workflow is intentionally lightweight.

## What to contribute

SpecRider is currently maintained by one person in their spare time. To keep review tractable, please scope contributions accordingly:

**Welcome:**
- Bug fixes
- Small, focused improvements to existing features
- Documentation fixes and clarifications
- Test coverage for existing behavior

**Please open an issue first** (before writing code) for:
- New features of any meaningful size
- Refactors that touch more than a handful of files
- Changes to core architecture, build, or packaging
- Dependency additions or upgrades beyond patch bumps

**Not accepted:**
- Large AI-generated PRs that sprawl across the codebase. If a tool wrote it, you still need to have read it, understood it, and kept it tight. PRs that look like dumped model output will be closed without review.
- Sweeping stylistic rewrites or "cleanup" passes unrelated to a specific bug or feature.

When in doubt, open an issue and ask before investing time. A two-line "is this something you'd take?" saves everyone the round trip.

## Quick start

```bash
pnpm install
pnpm tauri dev          # run the desktop app with hot reload
pnpm test               # vitest
(cd src-tauri && cargo test --lib)
```

`pnpm dev` runs the frontend-only Vite server if you want to iterate on UI without spinning up the Tauri shell.

## Workflow

1. Fork → branch → open a PR against `main`.
2. Keep PRs focused — one feature or one fix per PR. Mixed-concern diffs get split.
3. Match existing code style. The Rust crate is rustfmt-clean; the frontend follows the conventions visible in `src/components/`.
4. Add tests when you change behavior. The codebase has solid coverage in `tests/`, `src/**/*.test.ts`, and `src-tauri/src/**` — extend the nearest existing suite.
5. Keep commits clean (`git rebase -i` is your friend). Each commit should build and pass tests.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` trailer, signaling your agreement with the [Developer Certificate of Origin](https://developercertificate.org/). Add it automatically with:

```bash
git commit -s -m "Your message"
```

Or set it as a default for the repo:

```bash
git config format.signoff true
```

Unsigned commits will be rejected by the DCO check.

## Contributor License Agreement (CLA)

In addition to the per-commit DCO sign-off above, contributors must sign the project's Contributor License Agreement once before their first pull request can be merged. The CLA lets 805 Software LLC maintain SpecRider as GPL-3.0-or-later software while retaining the flexibility to offer it under other terms (for example, a commercial or hosted edition). **You keep the copyright to your contributions** — the CLA is a license grant, not an assignment.

- **Everyone** signs the [Individual CLA](CLA.md) — this is the signature the merge check enforces.
- **Contributing on behalf of an employer?** Your company *also* signs the [Corporate CLA](CCLA.md) and emails it in (see that file for the private submission process). The Corporate CLA is supplemental: it secures your employer's rights but does not replace your individual signature here.

Individual signing is handled by the repository's CLA workflow: when you open your first PR, it adds a `license/cla` status check and comments with the exact signing phrase if your GitHub username is not already on file. Review [CLA.md](CLA.md), comment the signing phrase on the PR, and the workflow records your signature in a private repository. You only sign once; later PRs are recognized automatically. The DCO sign-off and the CLA are both required — the DCO certifies origin per commit, the CLA grants the inbound license.

## Pull request checklist

- [ ] PR is focused on one feature or fix
- [ ] Tests added/updated and passing locally
- [ ] `pnpm check` clean
- [ ] `(cd src-tauri && cargo check)` clean
- [ ] Every commit signed with `-s` (DCO)
- [ ] CLA signed (first-time contributors — the workflow will prompt you)

## Filing issues

Bug reports: include OS, app version, repro steps, and (if possible) a minimal Markdown file that triggers the issue. Feature requests: explain the use case before the proposed solution — the use case is more useful than the implementation idea.

## Questions

Open a GitHub issue. The maintainer reads everything; it just may take a few days.
