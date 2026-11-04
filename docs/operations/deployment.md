# Deployment and upgrade guide

Wickmail is deployed through the flake's NixOS modules. Host-specific values
(domain, addresses, paths, secrets) live in the host configuration, never in the
flake. See [ADR 0011](../decisions/0011-nix-flake-first-class.md).

- Modules: [`infra/nixos/wickmail-mail.nix`](../../infra/nixos/wickmail-mail.nix),
  [`infra/nixos/wickmail-backup.nix`](../../infra/nixos/wickmail-backup.nix).
- Entry point: `apps/server/src/main.ts`, packaged as `wickmail-server`.
- There are **no default credentials**. The first run bootstraps a user through
  a local CLI command and a single-use setup token.

## Prerequisites

- Nix with flakes enabled.
- A host with a public IP, a working reverse DNS entry, and ports 25, 587, 993,
  and 443 reachable.
- DNS records published per [deliverability](deliverability.md).

## Configure the host

Add the flake as an input and import both modules. Every value below is
host-specific and belongs in the host configuration:

```nix
{
  inputs.wickmail.url = "github:nullcopy/wickmail";

  outputs = { self, nixpkgs, wickmail, ... }: {
    nixosConfigurations.mail = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        wickmail.nixosModules.default
        wickmail.nixosModules.wickmail-backup
        ./hosts/mail.nix
      ];
    };
  };
}
```

```nix
# hosts/mail.nix
{ ... }: {
  services.wickmail.mail = {
    enable = true;
    domain = "example.com";
    hostname = "mail.example.com";
    primaryAddresses = [ "me@example.com" ];
    # Point the unit at the packaged server. Override if you build it yourself.
    serverPackage = pkgs.callPackage ./wickmail-server.nix { };
    metrics.certificatePaths = [ "/var/lib/acme/example.com/fullchain.pem" ];
  };

  services.wickmail.backup.enable = true;

  # TLS is terminated by the reverse proxy and the mail daemons; use the ACME
  # module of your choice for the certificates referenced above.
  security.acme.certs."example.com".email = "admin@example.com";
}
```

The module sets the server's environment from these options, including
`WICKMAIL_DB`, `WICKMAIL_DOMAIN`, `WICKMAIL_PRIMARY_ADDRESS`, the mail and spool
directories, the policy and LMTP sockets, and the metrics paths.

## Build and deploy

```sh
nixos-rebuild switch --flake .#mail
```

The module configures Postfix (RCPT socketmap lookup and LMTP delivery), Rspamd
(spam and malware before the proxy), and Dovecot (LMTP, IMAP, mail auth, and the
isolated `Aliases/Expired` namespace). The `wickmail-server` unit owns the
policy and LMTP sockets.

## Bootstrap (first run, no default credentials)

Bootstrap creates the user and prints a single-use setup token. It runs with
local access to the host and the database only:

```sh
WICKMAIL_DB=/var/lib/wickmail/wickmail.db wickmail-server admin bootstrap
# prints a wmksetup_... token shown once
WICKMAIL_DB=/var/lib/wickmail/wickmail.db \
  wickmail-server admin setup --token <token> --password '<management password>'
# prints one-time recovery codes shown once
```

Set a separate mail password for IMAP and SMTP submission:

```sh
WICKMAIL_DB=/var/lib/wickmail/wickmail.db wickmail-server admin mail-password
```

Management and mail authentication are separate credentials for the same user
(see [ADR 0009](../decisions/0009-authentication-and-bootstrap.md)). Recovery is
local: either `admin password --password '<new>'` or the one-time recovery
codes. There is no email-based recovery and no default account.

## Upgrade

1. Back up first: `systemctl start wickmail-backup.service` or run
   `infra/scripts/backup.sh`.
2. Update the flake input and rebuild:

   ```sh
   nix flake update wickmail
   nixos-rebuild switch --flake .#mail
   ```

   Migrations run automatically at startup and are forward-only. They are
   applied by the server process before it serves requests.

3. Confirm health:

   ```sh
   curl -fsS http://127.0.0.1:8080/metrics | grep -E 'wickmail_(spool|reconciliation)'
   ```

## Recovery

If the host is lost, install the same configuration on a new host, restore the
most recent backup, reconcile, and start the services. The full procedure is in
[backup and restore](backup.md).

## Monitoring

The module passes the metrics paths and token to the unit. Point Prometheus at
`/metrics` and load the rules from [monitoring](monitoring.md). Restrict the API
listener to a private interface or set `services.wickmail.mail.metrics.tokenFile`.

## Known deployment gaps

The flake does not yet build the `wickmail-server` package; provide it through
`services.wickmail.mail.serverPackage` (or an overlay) until packaging lands.
See the [MVP release notes](../release/v0.1.0-notes.md).
