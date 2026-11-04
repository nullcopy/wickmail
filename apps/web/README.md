# wickmail-web

Responsive web management UI and focused reply composer for Wickmail, reused by the Android WebView shell.

Scope:

- Readable random alias generation with expiration selection
- Alias dashboard with expiry and recently-used filtering and sorting
- Alias detail and management flows
- Quarantine review and recovery
- Reply-as-alias composer with provenance-based identity selection
- Activity history and settings

See [web management app design](../../docs/design/web-app.md).

## How it works

The app is a React and Vite single-page application. It calls the same-origin
`/v1` management API through the `wickmail-core` API client, so the browser
attaches the `HttpOnly` session cookie without any cross-origin configuration.
It holds the CSRF token in memory only and never writes tokens or credentials
to browser storage. The server computes effective alias state and lease policy;
the client renders the server's values and never re-derives them.

## Development

```sh
nix develop
npm install
npm run dev -w apps/web
```

The Vite dev server proxies `/v1` to the management API (`WICKMAIL_API_URL`,
default `http://127.0.0.1:8080`), so development also uses same-origin requests.

## Build

```sh
npm run build -w apps/web
```

This writes `apps/web/dist`. In production the management origin serves these
static assets and the `/v1` API, so the app and API share an origin.

## Tests

```sh
npm test -w apps/web
```

Vitest with `@testing-library/react` and jsdom covers the pure query, filter,
and sort derivation (including no-expiry and never-used ordering), the generate
flow, the multi-alias identity prompt, composer outcomes, and quarantine
actions.
