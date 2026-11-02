# Wickmail Android WebView shell design

## Purpose

Package the web management app as an Android application while adding native conveniences that do not require duplicating the web UI.

The Android app is a management client, not an IMAP email client.

## Responsibilities

The native shell provides:

- A full-screen WebView hosting the management app
- Android back and forward navigation
- Connectivity and loading-error handling
- External-link handling
- Native copy and share integration where browser behavior is insufficient
- Optional app-link support for opening alias details
- Optional biometric app lock
- Release-signed updates through the chosen distribution channel

Alias logic, lease enforcement, and quarantine operations remain server-side.

## Navigation behavior

- The configured HTTPS management origin opens inside the WebView.
- Authentication pages on explicitly approved identity origins may open internally.
- Other external links open in the user's browser.
- Android Back navigates WebView history before closing the app.
- Deep links validate the destination and never accept an arbitrary WebView URL.
- Pull-to-refresh may reload current data but must not blindly repeat a mutation.

## Native integration

### Sharing and clipboard

- Alias addresses can be copied or shared immediately after creation or renewal.
- The app may expose an Android share target that accepts text or a merchant URL and opens the create screen with a suggested label.
- Native integrations must not grant web content access to unrelated device data.

### Optional biometric lock

- Locking occurs when the app is backgrounded for a configurable period.
- Biometric unlock gates access to the UI; it does not replace server authentication.
- A device-credential fallback can be offered according to user preference.

### Notifications

Notifications are a post-MVP enhancement:

- Alias expiring soon
- Mail quarantined for an expired alias
- Quarantine retention nearing deletion

Notifications should contain only the alias label or other minimal metadata, not email subjects or bodies.

## WebView security requirements

- Permit HTTPS only; disable cleartext traffic.
- Disable mixed content.
- Disable WebView debugging in release builds.
- Disable file and content access unless a specific feature requires it.
- Do not enable universal file-URL access.
- Avoid a JavaScript bridge by default.
- If a bridge becomes necessary:
  - Expose only explicit operations such as copy or share.
  - Restrict it to the exact management origin.
  - Never expose session cookies, API tokens, or general network primitives.
- Keep Android System WebView updated through normal platform mechanisms.
- Do not accept a target origin from an untrusted intent without validation.

## Offline and failure behavior

v1 requires connectivity for alias operations.

When offline:

- Show a native connectivity error with retry.
- Do not display a stale alias as newly created or renewed.
- Do not queue mutations invisibly.
- Preserve unsent form input locally where practical.

If the session expires, the WebView returns to the normal sign-in flow. Native code must not scrape or retain the user's password.

## Acceptance criteria

- All web management flows work inside the Android app without a separate mobile implementation.
- External links cannot navigate the privileged management WebView to arbitrary origins.
- Back navigation, session expiry, rotation, and process recreation behave predictably.
- Alias copy and share actions work on supported Android versions.
- Release builds expose no WebView debugging or credential-bearing JavaScript bridge.
- Offline behavior cannot falsely report successful alias creation, renewal, or recovery.
