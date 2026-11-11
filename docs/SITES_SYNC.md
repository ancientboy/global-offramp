# Sites v13 source synchronization

This repository tracks the application from the existing private Sites project.
Source snapshot: `47330e42861fab1dc0dd76b592ad057ceb97a425` (Sites v13).
The original snapshot's `integrated/` directory is mapped to this repository root.
Existing GitHub-only QA evidence is retained.

The snapshot's D1 SQL migrations and metadata are included under `drizzle/`.
`sites/d1-store.test.ts` resolves that directory from this standalone layout.
No credentials, installed dependencies, generated build/OCR assets, or Site project
identity/hosting configuration are copied. This commit does not deploy the Site.
The existing GitHub workflow only verifies and builds the MOCK application.

The code remains MOCK-only. It is not a real payment system and must not be exposed
as one. The Sites worker requires the existing authenticated private gateway,
D1/R2 bindings, and its original hosting deployment configuration. See
`sites/README.md` for persistence and access boundaries.
