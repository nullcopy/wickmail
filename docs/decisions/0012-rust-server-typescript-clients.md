# 12. Implement the server in Rust

## Status

Accepted

## Context

`wickmail-server` performs socketmap recipient policy lookups and runs an LMTP proxy with a durable spool in the mail path. It owns the SQLite alias store, performs crash-safe quarantine reconciliation, signs outbound replies with DKIM, and exposes the HTTP management API. It runs unattended on self-hosted hosts, so predictable resource use, a small dependency surface, and a single deployable binary matter. The clients are a browser-based web app and an Android WebView shell that hosts the same web app.

The design documents and earlier records left the implementation language open. This record fixes it.

## Decision

`wickmail-server` is implemented in Rust.

- Asynchronous I/O uses `tokio`. The socketmap policy lookup, the LMTP proxy, and the durable spool are implemented directly on it.
- The HTTP management API uses `axum`.
- SQLite is accessed through `rusqlite` with the bundled library, keeping the single-writer model and the schema and migrations defined in [ADR 0010](0010-sqlite-for-single-user-v1.md).
- Passwords are hashed with the RustCrypto `argon2` crate; optional passkeys use `webauthn-rs`; the CLI uses `clap`; the API contract uses `serde`; logs use `tracing`; metrics are exported in Prometheus format.
- The web app (`wickmail-web`) stays TypeScript with Svelte, and the Android shell (`wickmail-android`) stays Kotlin. See [ADR 0013](0013-typescript-svelte-web-app.md).
- `wickmail-core` becomes the TypeScript client package for the web app: request and response schemas plus an API client. It is no longer shared with the server, which owns its types in Rust.
- The Rust server is the source of truth for the HTTP contract. The TypeScript client mirrors it, and drift is caught by tests against the server's contract description or by shared fixtures.
- The Nix flake provides the Rust toolchain, builds `wickmail-server` with `rustPlatform.buildRustPackage`, commits `Cargo.lock`, and runs `rustfmt`, `clippy`, and `cargo test` in `nix flake check`. The web app keeps its Node toolchain in the same dev shell.

## Consequences

- The mail path runs in a language with predictable memory use and no garbage-collection pauses, and the server ships as a self-contained binary that is straightforward to run under systemd.
- The repository carries two toolchains. `wickmail-core` no longer spans the server, so the HTTP contract needs deliberate synchronization, which is a new source of drift that tests must guard.
- Contributors need the Rust toolchain, which the flake provides. `Cargo.lock` becomes a reviewed artifact, so dependency updates are explicit.
- Rust compile times are longer than the web build, so CI caches the Cargo registry and build directory.
