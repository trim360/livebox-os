# Changelog

## 5.0.0 — Rebirth (2026-11-10)

- Blue/cyan/violet light and dark workspace; customizable widgets and per-account window restoration.
- Global application/device search, keyboard widget ordering, mobile full-screen apps, performance profiles.
- SSH terminal with host-key verification; Docker inventory, stats, logs, Compose stacks and confirmed actions.
- Scoped SFTP directory browser; Linux metrics, processes, services, journals and seven-day CPU/RAM history.
- Viewer/operator accounts, access suspension, server-side authorization and isolated profiles.
- CPU/RAM/disk thresholds, recovery events and persistent HTTP service checks.
- Existing Livebox, TP-Link, NAT, avatar, wallpaper and backup integrations preserved.
- Nimbo integration excluded at the owner's request.


## 4.0.1 — 2026-10-26

- Fixed SSH connection testing: failed reads no longer create connected sessions; missing identity, rejected authentication, refused port and network failures have distinct messages.
- Added backend-managed dedicated Ed25519 keys and explicit host-fingerprint verification. Only public keys reach the browser; externally managed SSH folders remain supported and unchanged.
- Added Linux CPU measurements from counter deltas, RAM, filesystems, uptime and interface counters; missing optional services remain unavailable.
- Corrected the scrollable window content area without changing desktop, dock, icons or window controls.
- Added an account-scoped display name and persistent avatar, with browser crop/preview and server-side image validation, resizing and metadata removal.
- Replaced the fabricated Livebox illustration with licensed, credited photographs for verified Livebox 4/5/6 identities and a neutral fallback for other models. Card geometry and controls are retained.

This patch does not mark the unfinished V4 roadmap complete or create a stable V4 release automatically.

## 4.0.0-dev.1 — V4 development snapshot

Package and API version: `4.0.0-dev.1`. This branch is not a stable V4 release.

- Promoted the V4 desktop to `main` as the default source. The V3 tag is retained; no stable V4 release is created by this promotion.

- Restored the V3 desktop as the sole main interface: colored app grid, welcome text, connection card, wallpaper, top bar and translucent dock. Removed the separate dashboard shell; its useful views now open in desktop windows.
- Added keyboard window movement/resizing, stable pointer resizing, bounded window geometry, focus ordering, optional local geometry persistence and polling suspension for minimized network views.
- Added icon sizing/ordering, dock pinning, wallpaper focal position, optional reduced animations and Orange/amber actions. Existing custom images and V3 preferences are preserved; application backups accept V3 and the extended V4 preference schema.
- Added responsive desktop/window layouts, keyboard tabs, visible focus, two themes, optional overview sections, density and non-sensitive preference export/import.
- Added multiple router/server profiles, destination allowlisting, DNS pinning, passive gateway candidates, connection ownership and configurable session collectors.
- Added fixed OpenWrt ubus reads and optional dedicated-key SSH observations for Linux, systemd, Docker, WireGuard, OpenVPN and Tailscale. These integrations are protocol/adapter tested, not hardware validated.
- Added Livebox guest/schedule/firewall/ping/DMZ/DynDNS/reboot-history reads and confirmed guest/firewall/reboot operations, without executing them against real devices during development.
- Added local device annotations/favorites, availability history and CSV/JSON exports, opt-in measured ping latency/loss, transition-based notification rules, manual rule tests and acknowledgement.
- Added targeted ping, DNS, TCP and bounded traceroute diagnostics, cancellation of obsolete read requests, SSH/confirmation regression tests and additional secret-field redaction.
- Kept exact TP-Link firmware restrictions, existing Wi-Fi/DHCP/NAT/share/backup functionality and existing deployment defaults. No production upgrade is performed.
- Documented [remaining V4 work](docs/V4.md), [connector scope](docs/CONNECTORS.md), [SSH/VPN setup](docs/SERVERS-VPN.md) and [validation](docs/V4-VALIDATION.md).

## [3.0.0] — public release candidate

Prepared on 2026-10-25. This entry does not mean the release has already been published.

### Added

- Firmware-specific Archer AX58 V1 connector, authenticated WAN/LAN and client reads, Wi-Fi reads and confirmed NAT operations.
- Observed network topology, coordinated double-NAT preparation, conflict checks, verification, managed updates/deletes and ownership-limited rollback.
- Network monitoring, persistent audit events and diagnostics for both routers.
- Read-only SMB2/3 shares with explicit server/share selection, directory browsing and bounded downloads.
- Public English/French documentation, MIT license and third-party notices, contribution/security policies, issue templates and CI checks.

### Fixed

- Livebox NAT object/PascalCase parsing and case differences in device/call data.
- Consistent Livebox → TP-Link rule order and destination selection when editing an operation.
- Secret redaction, session cleanup and preferences persistence after failed loads.

### Security and packaging

- Public candidate uses FastAPI 0.162.0, Starlette 1.10.0 and cryptography 50.0.2 following advisory review.
- Private deployment notes, real network fixtures and owner-supplied legacy raster artwork are excluded from the public repository. The current SVG-based interface is preserved.
- Public history starts from a sanitized source snapshot. The private development repository and deployed system are preserved separately.

### Known limits

- Hardware verification covers Livebox 5 and Archer AX58 V1.0 firmware 1.5.2 Build 20250812 rel.38324(4555), not all Orange/TP-Link devices.
- TP-Link Wi-Fi writes, TP-Link firewall reads, public port reachability and a real authenticated SMB share are not validated.
- Existing NAT rules are preserved and are not automatically adopted into coordinated operations.
