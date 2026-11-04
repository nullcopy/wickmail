# 13. Implement the web app in TypeScript with Svelte

## Status

Accepted

## Context

`wickmail-web` is the only user interface. The Android app is a thin Kotlin WebView shell that hosts the same web app, so there is no separate native UI. The web app is a form-heavy management console plus a focused reply composer: a dashboard with filtering and sorting, alias detail and management, quarantine review, a reply composer, and settings. It is served from the management API's origin, talks to the same-origin Rust HTTP API, and consumes the `wickmail-core` TypeScript client package.

The design documents left the web stack open, and [ADR 0012](0012-rust-server-typescript-clients.md) fixed the server as Rust while asserting the client stacks without reasoning. This record fixes the web stack.

## Decision

`wickmail-web` is implemented in TypeScript with Svelte.

- The app is a client-rendered single-page app built by Vite, with client-side routing. The Rust server serves the built static assets; no Node runtime is deployed.
- Svelte compiles components to small, direct DOM operations with no virtual-DOM layer, which suits an app of this size and shape.
- Types are checked with `svelte-check`. Formatting uses Prettier with `prettier-plugin-svelte`; linting uses ESLint with `eslint-plugin-svelte`.
- `wickmail-core` remains the TypeScript client package for the web app: request and response schemas plus an API client. The Rust server stays the source of truth for the HTTP contract, and the TypeScript client mirrors it.
- The Nix flake provides the Node and Vite toolchain in the same dev shell as the Rust toolchain, and runs the web build, `svelte-check`, Prettier, and ESLint in `nix flake check`.
- The Android shell (`wickmail-android`) stays Kotlin and hosts the built web app; it does not consume `wickmail-core` directly.

## Consequences

- The app ships as small static assets with fast startup in both browsers and the Android WebView, and the code volume for this screen set is lower than an equivalent React app.
- Svelte has a smaller ecosystem and fewer ready-made component libraries than React, so more UI is written directly, and contributors need Svelte knowledge.
- Svelte's major-version churn is a maintenance consideration; the flake pins the toolchain and the lockfile is committed so upgrades are explicit.
- The client and server contract still needs deliberate synchronization, and the `wickmail-core` client is where drift is caught.
