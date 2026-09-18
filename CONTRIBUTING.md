# Contributing

Use Node.js 24.15.0 and the committed npm lockfile. See the README for install, check, test and build commands.

For a bug report, include the extension/Chrome versions, reproduction steps, expected behavior and a minimal artificial example where possible. Do not attach personal annotation exports, authenticated-page content, credentials, private documents or a browser profile.

Changes to anchoring, page identity, storage or import must include a regression case. Preserve failed/ambiguous annotations rather than silently attaching them to different content. Keep text/image input validation at the background boundary.

Before opening a pull request, run `npm run check`, `npm test`, `npm run build` and `npm run test:e2e`. Do not commit `.output`, `Web-Ink-Chrome`, `node_modules`, browser profiles or test reports. Only artificial screenshots belong in `docs/images`.

The extension is local-first. New network access, permissions, data retention or upload behavior must be explicitly described in the change and privacy documentation.
