# Deployment guide

This guide installs and upgrades Wickmail on NixOS through
`nixosModules.default`. Host-specific values (domains, addresses, credentials,
and key paths) live in your host configuration, never in the flake. There are
no default credentials: the mail password is a required option, and management
credentials are created by an explicit bootstrap command.

See [ADR 0011](../decisions/0011-nix-flake-first-class.md) for why the flake is
the supported deployment interface, and [ADR 0009](../decisions/0009-authentication-and-bootstrap.md)
for the authentication model.

## Prerequisites

- A NixOS host with the flake available as an input.
- A public hostname for the mail host (for example `mail.example.com`) and a
  domain whose aliases you will create (for example `example.com`).
- Inbound TCP 25, submission TCP 587, and IMAPS TCP 993 reachable; outbound
  TCP 25 permitted by the host and network provider.
- DNS records as described in [deliverability.md](deliverability.md), including
  reverse DNS for the mail host's public address.
- A TLS certificate for the mail host. `security.acme` is the recommended
  source; point `services.wickmail.tls` at the resulting files.

## Flake input

```nix
{
  inputs.wickmail.url = "github:nullcopy/wickmail";
}
```

Pin the input in your `flake.lock`; do not track a moving branch in
production.

## Host configuration

Keep host-specific values in a file outside the Wickmail flake. A complete
starting point is [`infra/hosts/example.nix`](../../infra/hosts/example.nix).
The minimum configuration is:

```nix
{ inputs, ... }:
{
  imports = [ inputs.wickmail.nixosModules.default ];

  services.wickmail = {
    enable = true;
    domain = "example.com";
    primaryAddress = "user@example.com";
    mailPassword = "replace-with-a-generated-secret";
  };
}
```

### Required values

| Option | Meaning |
|---|---|
| `services.wickmail.domain` | The alias domain. |
| `services.wickmail.primaryAddress` | The account's primary address. |
| `services.wickmail.mailPassword` | IMAP/SMTP mail password. Required; no default. |
| `services.wickmail.hostname` | Mail host name; defaults to `mail.<domain>`. |

### Recommended values

| Option | Meaning |
|---|---|
| `services.wickmail.dkimKeyFile` | PEM RSA key used to DKIM-sign outbound replies. |
| `services.wickmail.tls.certificateFile` / `tls.keyFile` | TLS chain and key for Postfix and Dovecot. |
| `services.wickmail.enableSubmission` | Authenticated submission with the alias ownership check. |
| `services.wickmail.backup.enable` | Scheduled backups. |
| `services.wickmail.monitoring.enable` | Periodic health checks and alerts. |

Secrets should not be committed. Supply `mailPassword` and the DKIM key from a
secret manager such as sops-nix or agenix, or from an out-of-store file that
the systemd unit can read.

## First-run bootstrap

The server creates its schema on start, but the management user does not
exist until you bootstrap it. Bootstrap runs locally against the database
file; there are no default credentials.

```console
# Create the user and print a single-use setup token.
wickmail-server bootstrap \
  --db /var/lib/wickmail/wickmail.sqlite \
  --primary user@example.com

# Complete setup with the token, setting the management password.
wickmail-server set-password \
  --db /var/lib/wickmail/wickmail.sqlite \
  --setup-token <token> --password-stdin
```

The setup token is single-use and expires after 24 hours. Alternatively, POST
it to `POST /v1/setup` from the web app. Generate one-time recovery codes and
store them offline:

```console
wickmail-server recovery-codes --db /var/lib/wickmail/wickmail.sqlite
```

The mail credential is separate from the management credential. Rotate it with
`wickmail-server mail-credential rotate --db ...` and update Dovecot with the
printed password; the module's static passdb uses `mailPassword`, so rotate
both together.

## Build and switch

```console
sudo nixos-rebuild switch --flake .#<host>
```

The `wickmail.service` unit runs `wickmail-server migrate` before starting, so
schema upgrades apply automatically. Verify the services:

```console
systemctl status wickmail.service dovecot.service postfix.service
systemctl list-timers 'wickmail-*'
wickmail-monitor --print
```

## Upgrades

1. Update the flake input and review the lock diff:
   ```console
   nix flake update wickmail
   ```
2. Read the release notes for the new revision.
3. Take a backup before switching:
   ```console
   wickmail-backup --state-dir /var/lib/wickmail --mail-root /var/vmail \
     --output /var/backup/wickmail --config-dir /etc/wickmail
   ```
4. Switch:
   ```console
   sudo nixos-rebuild switch --flake .#<host>
   ```
5. Confirm `wickmail.service` restarted cleanly and the spool drained:
   ```console
   systemctl status wickmail.service
   wickmail-server spool-stats --dir /var/lib/wickmail/spool
   ```

Schema migrations are forward-only. A downgrade requires restoring the backup
taken in step 3; see [backup-restore.md](backup-restore.md).

## Recovery

- **Lost management password:** reset it from the host with
  `wickmail-server reset-password --db /var/lib/wickmail/wickmail.sqlite
  --password-stdin`. This revokes existing sessions. A one-time recovery code
  works through `POST /v1/recovery` when host access is unavailable.
- **Lost mail password:** rotate with
  `wickmail-server mail-credential rotate --db ...` and set the same value in
  `services.wickmail.mailPassword`.
- **Lost host:** restore the latest backup and re-run the bootstrap only if the
  management user is missing. See [backup-restore.md](backup-restore.md).
- **Lost DKIM key:** generate a new key, publish the new selector record, and
  set `services.wickmail.dkimKeyFile`. Old signatures remain valid until their
  DNS records are removed.

## Layout reference

| Path | Purpose |
|---|---|
| `/run/wickmail/policy.sock` | Postfix socketmap for RCPT policy lookup |
| `/run/wickmail/submission.sock` | Postfix socketmap for outbound ownership |
| `/run/wickmail/lmtp.sock` | LMTP socket Postfix delivers to |
| `/run/dovecot2/lmtp` | Dovecot LMTP socket the proxy forwards to |
| `/var/lib/wickmail/wickmail.sqlite` | Alias database |
| `/var/lib/wickmail/spool` | Durable inbound spool |
| `/var/lib/wickmail/outbound` | Queued outbound replies |
| `/var/vmail/Maildir` | Account mail store |
| `/var/vmail/quarantine/.Expired` | Quarantine Maildir |
