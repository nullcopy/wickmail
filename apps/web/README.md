# wickmail-web

Responsive web management UI and focused reply composer for Wickmail, implemented in TypeScript with Svelte and reused by the Android WebView shell.

Scope:

- Readable random alias generation with expiration selection
- Alias dashboard with expiry and recently-used filtering and sorting
- Alias detail and management flows
- Quarantine review and recovery
- Reply-as-alias composer with provenance-based identity selection
- Messages, activity, and settings screens

Consumes the Rust server's management API through the [wickmail-core](../../packages/core/README.md) client package. See [web management app design](../../docs/design/web-app.md), [ADR 0012](../../docs/decisions/0012-rust-server-typescript-clients.md), and [ADR 0013](../../docs/decisions/0013-typescript-svelte-web-app.md).

## Structure

- `src/App.svelte` and `src/main.ts` mount the app and choose a screen from the current path.
- `src/lib/` holds the same-origin API client (`api.ts`), routing, session, preferences, and the pure presentation logic that the tests cover.
- `src/components/` holds shared UI: dialogs, status badges, copy and share actions, and banners.
- `src/routes/` holds the screens: login and setup, dashboard, alias detail, quarantine, messages, activity, and settings.

The app is served from the management API origin and talks to `/v1` on the same origin. It authenticates with a `Secure`, `HttpOnly` session cookie plus a CSRF token on mutations, or with an API token the user enters for the session. Tokens are held in memory only and are never written to browser storage; the only persisted values are non-sensitive UI preferences.

## Development

```sh
npm run dev    # Vite dev server
npm run build  # production build into dist/
npm run check  # svelte-check
npm run lint   # ESLint
npm run test   # pure-logic tests with node:test
```
