# 11. Make a Nix flake the first-class build, development, and deployment interface

## Status

Accepted

## Context

Wickmail spans a server, a web app, an Android shell, mail-server configuration, and operational tooling. Each area has a different toolchain, and self-hosting means operators must build, run, and reproduce the system on machines we do not control. Per-language build scripts and host-specific setup steps would make builds non-reproducible and would force CI to duplicate what developers run locally.

## Decision

A top-level `flake.nix` is the canonical interface for building, developing, testing, deploying, and running Wickmail. Every concern that can be expressed as a flake output is:

- `packages.*`: `wickmail-server`, `wickmail-web`, `wickmail-android`, and container images, built reproducibly.
- `devShells.default`: the pinned toolchain for every language and for Android SDK and NDK.
- `checks.*`: formatting, lint, unit, and integration tests, runnable with `nix flake check`.
- `nixosModules.*` and deployment outputs: the server, Postfix, Dovecot, Rspamd, systemd units, and mail configuration.
- `apps.*`: convenience runners for common tasks.

CI builds the packages and runs `nix flake check`, so CI and local builds use the same derivations from the same pinned inputs. Developer onboarding is `nix develop`. Documentation and README instructions present Nix commands as the primary path.

The flake pins nixpkgs and all inputs through a committed `flake.lock`. Host-specific values such as domains, credentials, and mail hostnames stay out of the flake and are supplied at deploy time. Non-Nix build paths may exist for convenience, but they are not the supported or tested path.

## Consequences

Builds are reproducible across developer machines and CI, and a single toolchain definition serves development, testing, and deployment. `flake.lock` becomes a reviewed artifact, so input upgrades are explicit and auditable. Contributors must have Nix, or use a Nix-provided container, which is a real barrier for those without it. The Android build depends on the flake providing a working SDK and NDK derivation, which is the most fragile part of the toolchain. Deployment configuration is split between the flake, which defines the modules, and host configuration, which supplies the values.
