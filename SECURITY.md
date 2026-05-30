# Security policy

## Supported versions

We support the latest stable release. Older releases receive fixes on a best-effort basis.

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's "Report a vulnerability" flow on the Security tab:

  https://github.com/endara-ai/endara-desktop/security/advisories/new

Please do **not** open public issues or pull requests for security reports.

## What to expect

- We aim to **acknowledge new reports within 3 business days**.
- We aim to **provide a status update within 7 business days** of acknowledgement.
- We will coordinate disclosure timing with the reporter and credit you (with permission) in the resulting advisory.

## Scope

**In scope**

- The `endara-desktop` Tauri app shell, its IPC commands, the bundled `endara-relay` sidecar, the OAuth callback handler, and the management API (Unix-domain socket on macOS/Linux, Named Pipe on Windows).
- The `endara-relay` binary itself — please report relay-only issues at https://github.com/endara-ai/endara-relay/security/advisories/new, but if you're unsure which side is affected, reporting here is fine.

**Out of scope**

- Third-party MCP servers configured as upstreams. The relay faithfully forwards their responses; sandboxing upstreams is a non-goal (see `THREAT_MODEL.md` → "Known residual risks").
- User-misconfigured token directories (e.g. tokens placed on cloud-synced paths like Dropbox or iCloud Drive). The app surfaces an in-product warning but cannot prevent it.
- Issues only reproducible by an attacker who already has administrative or local code-execution access as the same OS user.

See the relay repository's `THREAT_MODEL.md` for the full threat model and trust boundaries: https://github.com/endara-ai/endara-relay/blob/main/THREAT_MODEL.md
