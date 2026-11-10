# V5 Rebirth — migration and implementation record

Baseline: 6f2ee8530c46659cdf68464c0f755f47f7572579, V4.0.1. The 99 backend and 11 frontend tests pass before changes (2026-11-10). Production reports V4.0.1 and healthy application containers. Nimbo is retired and explicitly excluded by the owner.

## Audit and plan

React 19/TypeScript/Vite/Tailwind, FastAPI, SQLite and authenticated WebSockets are retained. Existing windows, router adapters, NAT confirmations, SMB path checks, account hashing, avatars and wallpaper persistence remain the compatibility boundary. There are no fabricated monitoring metrics in the inspected application paths. Empty and unsupported reads must remain explicit.

Current limitations: one administrator; session-bound monitoring; no interactive SSH terminal; Docker listing only; no configurable dashboard; eager application imports; V3 geometry cannot restore an entire session. Existing router credentials are memory-only, so an expired router login cannot be silently recreated after a restart. The public Docker deployment does not mount a Docker socket or personal SSH directory.

The V5 work adds account roles, per-account workspace state, a hybrid dashboard/desktop, bounded SSH administration and Docker actions with confirmation. Existing router tools remain available. New accesses require a registered server, its dedicated key and verified host identity. No production service action is used as a test. Optional services display their actual availability.

## Visual direction

The owner's brief sets deep dark and deliberate light themes, electric blue/cyan accents and occasional violet. A narrow navigation rail identifies the workspace; the dashboard uses an asymmetric network summary, telemetry charts and compact event rows. Translucency belongs to window chrome and overlays only. Motion communicates window placement and state changes; performance/reduced-motion disable decorative transitions. Existing custom wallpapers are preserved.

## Reversible migration

Keep the V4 source and images, back up the private data volume and deployment files, build V5 against a separate test volume, then switch only the two Livebox OS containers after checks. Never overwrite `.env`, router secrets or host SSH keys. New account/workspace files are additive. Rollback uses the previous image IDs and Compose override; the database remains compatible with V4. Full data-volume backups include SSH keys and must stay private.

Validation before deployment: 106 backend tests and 13 frontend tests pass; production TypeScript/Vite build passes. The added SSH integration test establishes a real local encrypted connection with a dedicated key and rejects an altered host key. The HTTP monitoring test contacts an isolated HTTP server and verifies URL/SSRF rejection. Docker mutation tests verify owner binding, expiry/single use, typed confirmation and state drift using a controlled adapter.

Browser checks cover widget order and window restoration after reload, minimization/restoration, vertical scrolling, full-width mobile windows and no document overflow at 390, 768, 1366, 1920, 2560 and 3840 px. A mobile max-width conflict was found and fixed. Light/dark screenshots use an isolated empty instance. Production router secrets were not read or reused for tests. Hardware re-login is required after the backend restart.

Dependency audits report no known vulnerabilities at validation time; retained licenses include unmodified AsyncSSH under EPL-2.0 and xterm/addon-fit under MIT. Gitleaks reports no findings in the existing Git history and publication tree. This is not a guarantee against unknown vulnerabilities.

For deployment, create an immutable source release, build both images while V4 is running, back up the private volume, then replace only Livebox OS frontend/backend. Verify health/version, authentication boundary, unchanged private file hashes, preserved database rows and other running container IDs. The private deployment script automatically restores prior images/override on failure. Keep the generated rollback command and archives private. New SSH trust/authorized-key setup is a separate explicitly authorized operation after the preservation check.
