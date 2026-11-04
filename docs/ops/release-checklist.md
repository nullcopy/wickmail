# MVP release checklist

This is the release checklist for the Wickmail MVP. It maps the acceptance
criteria across the design documents to their verification, records the
verification results for the release revision, and states the release notes,
known limitations, and follow-ups. Tagging is left to the maintainer; the
exact command is at the end.

## Scope

The MVP is the single-user, self-hosted system described in
[overview.md](../design/overview.md): the Rust server (alias core, inbound
mail path, quarantine, reply path, management API), the Svelte web app, the
Android WebView shell, the NixOS modules, and the operational tooling added in
this milestone.

## Acceptance criteria

| Source | Status | Verification |
|---|---|---|
| [mail-server.md acceptance criteria](../design/mail-server.md#acceptance-criteria) (18 criteria) | met | `nix/tests/mail-path.nix`, the Rust unit and integration suites, and [`mail-server-acceptance.md`](../design/mail-server-acceptance.md) |
| [mail-server.md failure-injection matrix](../design/mail-server.md#testing) | met | `tests/quarantine_recovery.rs` and `tests/inbound_path.rs` |
| [web-app.md acceptance criteria](../design/web-app.md#acceptance-criteria) | met | web checks (`web-svelte-check`, `web-test`, `web-build`) and the management API integration tests |
| [android.md acceptance criteria](../design/android.md#acceptance-criteria) | met | `android-shell` and `android-logic` checks |
| Backups and a restore and reconciliation drill (M9.1) | met | `nix/tests/backup-restore.nix` |
| Monitoring and alerting (M9.2) | met | `wickmail-monitor`, the NixOS timer, and [`monitoring.md`](monitoring.md) |
| Deliverability (M9.3) | documented, external checks manual | [`deliverability.md`](deliverability.md); DKIM alignment verified offline |
| Deployment guide (M9.4) | met | [`deployment.md`](deployment.md) and [`infra/hosts/example.nix`](../../infra/hosts/example.nix) |
| Abuse controls (M9.5) | met | `nix/tests/abuse-controls.nix` and [`abuse-controls.md`](abuse-controls.md) |
| Release checklist and tag (M9.6) | this document | — |

## Verification commands

```console
# Full gate: formatting, lint, unit, integration, and NixOS VM tests.
nix flake check

# Individual operational tests.
nix build .#checks.x86_64-linux.backup-restore
nix build .#checks.x86_64-linux.abuse-controls
nix build .#checks.x86_64-linux.mail-path

# Rust suites directly.
nix develop -c bash -c 'cd apps/server && cargo test'
```

## Recorded results

Recorded for this revision:

- `nix flake check`: passes (formatting, lint, Rust, web, Android, and the
  three NixOS VM tests).
- `backup-restore`: passes. The drill backs up, simulates loss, restores, and
  verifies reconciliation repairs the mail store (`deleted=1`).
- `abuse-controls`: passes. Unknown recipient `550`, relay attempt denied
  (`454`), oversized message `552`, inbound per-sender limit holds the inbox at
  two, outbound submission `450` after the limit, and a full disk records
  `alert [disk_full]` with a `451` temporary failure.
- Rust suite: all unit and integration tests pass.
- DKIM: `cargo test dkim` verifies the signature is DMARC-aligned.

## Release notes: v0.1.0

**Wickmail v0.1.0** is the first MVP release: self-hosted email with
programmable, expiring aliases.

Highlights:

- Readable, randomly generated alias addresses with leases of 24 hours,
  7 days, 30 days, or a custom expiry. Inbound mail never extends a lease.
- Mail to an active alias reaches the inbox; mail at or after expiry is
  quarantined outside the IMAP namespace and is recoverable from the app.
- Reply as the receiving alias, with the primary address stripped and DKIM
  signatures aligned for DMARC.
- Authenticated management API with browser sessions, scoped API tokens, and
  a Svelte web app that also runs in the Android WebView shell.
- NixOS modules that wire Postfix, Rspamd, Dovecot, and the Wickmail server,
  with backup, monitoring, abuse-control, and TLS options.
- Operational tooling: `wickmail-backup`, `wickmail-restore`, and
  `wickmail-monitor`, plus a Prometheus textfile collector and alert rules.

## Known limitations

- **Single user.** v1 supports one primary mailbox and one account; multiple
  users and delegated ownership are out of scope.
- **No general webmail.** The app includes a focused reply composer, not a
  message browser.
- **`wickmail.service` runs as root.** Privilege separation is not yet
  implemented; the proxy needs access to the mail store and the Dovecot LMTP
  socket. See the follow-up issue.
- **Deliverability checks are manual.** DNS, reverse DNS, and external inbox
  placement require a live domain and outbound port 25, so they are performed
  on the deployed host.
- **Metrics via textfile collector.** The server logs counters and the monitor
  writes a textfile for node-exporter; there is no native `/metrics` endpoint
  yet.
- **Backups are unencrypted.** The archive contains mail bodies and the
  database; protect it at rest and store it off the host.
- **No MTA-STS or DANE/TLSA.** TLS is opportunistic (STARTTLS) plus required
  on submission.
- **Schema migrations are forward-only.** Downgrading requires restoring a
  backup.

## Follow-ups

Remaining follow-ups are filed as issues:

- #93 native Prometheus metrics endpoint
- #94 MTA-STS and DANE/TLSA
- #95 privilege separation for `wickmail.service`
- #96 backup encryption and off-host replication

## Tagging

Do not tag from this milestone; the maintainer tags after the pull request is
merged. The exact command and notes:

```console
git checkout main
git pull --ff-only
git tag -a v0.1.0 -m "Wickmail v0.1.0: self-hosted email with expiring aliases"
git push origin v0.1.0
```

Attach the "Release notes: v0.1.0" section above and the known limitations to
the GitHub release for the tag.
