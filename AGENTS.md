# Agent Instructions

## Versioning

- Every committed project change must include a version bump.
- Choose the bump using semantic versioning:
  - `patch` for bug fixes, small data/content edits, documentation, tooling, and other backward-compatible maintenance.
  - `minor` for backward-compatible gameplay features, server features, client features, or meaningful content additions.
  - `major` for breaking protocol, save-data, deployment, or gameplay contract changes.
- Keep the root `package.json` / `package-lock.json` project version in sync with `src/server/package.json` / `src/server/package-lock.json` unless a change clearly applies to only one package.
- Mention the selected bump level and resulting version in the final response and PR/comment summary.
