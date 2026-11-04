# 12. Implement Wickmail in TypeScript on Node.js with an npm workspace monorepo

## Status

Accepted

## Context

Wickmail needs a server that serves the HTTP management API, answers the Postfix socketmap/policy lookup, and proxies delivery over LMTP, plus a responsive web app that runs in browsers and inside the Android WebView shell. The policy lookup sits in the mail path, so it must answer quickly, stay bounded, and never execute arbitrary user code. Persistence is SQLite ([ADR 0010](0010-sqlite-for-single-user-v1.md)), passwords are hashed with Argon2id, and management authentication is separate from mail authentication ([ADR 0009](0009-authentication-and-bootstrap.md)).

The API contract is shared by the server and the web app, and the Nix flake ([ADR 0011](0011-nix-flake-first-class.md)) must provide one reproducible toolchain for build, test, and development. The Android shell is already fixed as a Kotlin/Gradle WebView host and shares no code with the rest of the system.

## Decision

Implement Wickmail in TypeScript on Node.js 22 LTS, provided by the Nix flake dev shell, as an npm workspace monorepo rooted at `apps/*` and `packages/*`:

- `apps/server`: TypeScript server for the HTTP management API, the socketmap/policy lookup, and the LMTP proxy.
- `apps/web`: TypeScript, React, and Vite management app.
- `packages/core`: shared zod schemas, types, and the API client.
- Tests use Vitest, formatting uses Prettier, and linting uses ESLint.
- Persistence is SQLite ([ADR 0010](0010-sqlite-for-single-user-v1.md)); password hashing is Argon2id.
- The Android shell stays a Kotlin/Gradle WebView host.

`packages/core` owns the zod schemas for requests and responses. The server validates inbound data with them and the web app consumes them through the API client, so the contract is defined once. Node.js 22 LTS is the current long-term release and is available as a pinned derivation in the flake.

## Consequences

One language and one toolchain cover the server, the web app, and the shared package, so the API contract has a single definition and the flake pins every build dependency. TypeScript adds a compile and type-check step to the build, and native dependencies such as Argon2id and the SQLite driver must build against the Nix-provided Node.js. Node.js runs JavaScript on a single event loop, which suits the single-user v1 but requires the policy lookup to stay bounded and off the request's critical path. The Android shell keeps its own Gradle toolchain, which the flake must provide in M8.
