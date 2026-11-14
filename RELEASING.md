# Releasing ChatFlow

Follow this 5-step checklist for every release (`manifest.json` is the single source of truth):

1. **Update `CHANGELOG.md`**: Move or write upcoming changes under `## [Unreleased]`, including concise `### Highlights` bullets (up to 4) for the post-update What's New card.
2. **Run the release script**: Run `npm run release:patch` (`2.5.1`), `npm run release:minor` (`2.6.0`), or `npm run release:major` (`3.0.0`) to bump `manifest.json` and `package.json`, roll `[Unreleased]` into a dated `CHANGELOG.md` heading, update `README.md`, regenerate `src/version.js`, and verify consistency.
3. **Run checks & tests**: Run `npm test` (includes `npm run version:check`) and `npm run lint`, verifying 0 errors and all suites pass.
4. **Reload and test in Chrome**: Reload the unpacked extension on `chrome://extensions`, confirm the side panel prompts open chat tabs to reload, and smoke-test WhatsApp Web and Messenger scans + `.docx`/`.txt`/`.pdf` exports.
5. **Build the release zip**: Run `npm run build:zip` to create `chatflow-v<version>.zip` containing only runtime extension files.
