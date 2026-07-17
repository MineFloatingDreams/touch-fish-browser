# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Windows x64 Electron mini-browser. Application code lives in `src/`: `main.js` owns Electron lifecycle, windows, sessions, and IPC; `preload.js` exposes the restricted renderer bridge; `core.js` contains pure validation and state helpers; and `settings-store.js` persists settings. Local UI files are under `src/ui/`. Unit tests live in `test/*.test.js`, while `test/integration-smoke.mjs` exercises real Electron behavior. Packaging resources belong in `build/`; bundled offline Electron archives are kept in `vendor/electron/`. Generated evidence goes to `test-artifacts/` and must not be committed.

## Build, Test, and Development Commands

- `npm ci` installs the exact versions recorded in `package-lock.json`.
- `npm start` launches the application from source.
- `npm run check` syntax-checks all JavaScript entry points.
- `npm test` runs the Node unit tests.
- `npm run test:integration` runs the Electron integration smoke suite on Windows.
- `npm run build:portable` creates the x64 portable executable.
- `npm run build:win` builds both NSIS installer and portable variants.

Packaging output is written directly to the repository root. Run `check` and unit tests before slower integration or packaging tasks.

## Coding Style & Naming Conventions

Use CommonJS in `.js` files and ES modules only where already established (`.mjs`). Follow the existing style: two-space indentation, double quotes, semicolons, trailing commas in multiline lists, `camelCase` for functions/variables, `PascalCase` for classes, and `UPPER_SNAKE_CASE` for constants. Keep reusable logic in `core.js` so it can be tested without Electron. No formatter or linter is configured; match surrounding code and run `npm run check`.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name unit files `<area>.test.js` and use behavior-focused test descriptions. Add tests for validation boundaries, migrations, persistence, and security-sensitive URL or permission behavior. Integration tests may create `test-artifacts/`; keep them deterministic and clean up temporary state. Follow `TESTING.md` for the manual Windows acceptance checklist.

## Commit & Pull Request Guidelines

The repository has no commit history yet. Use concise imperative commits, preferably Conventional Commit prefixes such as `feat: add tab restore` or `fix: reject unsafe protocol`. Keep each commit focused. Pull requests should explain user-visible behavior, list verification commands, link related issues, and include screenshots for UI or advertising-mode changes. Call out changes to permissions, persistence, installers, or unsigned binaries explicitly.

## Security & Configuration

Preserve renderer sandboxing, context isolation, disabled Node integration, and the HTTP/HTTPS-only navigation policy. Never commit user data, cookies, custom ad images, logs, generated artifacts, or signing credentials.
