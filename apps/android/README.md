# wickmail-android

Android WebView shell that hosts the Wickmail web management app.

The shell packages the same web app that browsers use, adds native navigation,
connectivity, copy and share, and an optional app lock, and keeps all alias,
lease, reply-identity, and quarantine logic on the server. See the
[Android WebView shell design](../../docs/design/android.md) and
[ADR 0012](../../docs/decisions/0012-typescript-monorepo-on-node.md).

## Responsibilities

- Full-screen WebView hosting the configured HTTPS management origin
- Back navigation through WebView history, then the app
- Native connectivity error with retry
- External links handed to the user's browser or another app
- Native copy and share for alias addresses, with confirmation
- Optional app links that open alias details
- Optional biometric app lock that degrades gracefully
- Release signing supplied out of band, and a documented update path

The shell does not evaluate leases, select reply identities, or compute
effective alias state.

## Project layout

```text
apps/android/
  settings.gradle.kts        Gradle settings and module list
  build.gradle.kts           Root build file
  gradle.properties          Build-time deployment configuration
  gradle/libs.versions.toml  Dependency version catalog
  app/
    build.gradle.kts         App module, configuration, and release signing
    src/main/                Manifest, resources, and Kotlin sources
    src/test/                JVM unit tests (pure logic)
    src/androidTest/         Instrumentation tests (device or emulator)
```

The pure logic lives in a few small classes with no Android dependency, so it
runs as plain JVM unit tests:

- `web/NavigationPolicy` decides whether a URL loads in the WebView, opens
  externally, or is refused.
- `deep/DeepLinkPolicy` validates alias app links and maps them to a management
  URL.
- `config/AppConfig` and `config/WebOrigin` parse and validate the build
  configuration.
- `bridge/NativeBridge` parses the copy, share, and app-lock messages the
  management page may send.
- `lock/LockPolicy` decides when the app lock applies.

## Configuration

Deployment values are supplied at build time through Gradle properties or
environment variables. None are secrets. The same value can be set with a
`-P` flag, in `gradle.properties`, or through the matching environment variable.

| Gradle property             | Environment variable         | Meaning                                                                             |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `wickmail.managementOrigin` | `WICKMAIL_MANAGEMENT_ORIGIN` | HTTPS origin of the management app. Required; empty produces a configuration error. |
| `wickmail.identityOrigins`  | `WICKMAIL_IDENTITY_ORIGINS`  | Comma-separated HTTPS origins whose pages may load inside the WebView.              |
| `wickmail.appLinkHosts`     | `WICKMAIL_APP_LINK_HOSTS`    | Comma-separated hosts that may deliver alias app links.                             |
| `wickmail.appLockDefault`   | `WICKMAIL_APP_LOCK_DEFAULT`  | Whether the app lock is enabled by default. Defaults to `true`.                     |

Example:

```sh
./gradlew :app:assembleDebug \
  -Pwickmail.managementOrigin=https://wickmail.example.com \
  -Pwickmail.identityOrigins=https://login.example.com \
  -Pwickmail.appLinkHosts=wickmail.example.com
```

A build without `wickmail.managementOrigin` starts and shows a native
configuration error instead of loading an arbitrary origin.

## Build

The Nix flake is the canonical toolchain ([ADR 0011](../../docs/decisions/0011-nix-flake-first-class.md)).
The dev shell provides a JDK; Gradle runs from the project wrapper. The Android
SDK is installed separately because its packages require license acceptance and
large downloads.

```sh
# Enter the dev shell for a JDK, then point Gradle at an Android SDK.
nix develop

# One-time: install the Android command-line tools and SDK packages, then accept
# licenses. Any recent SDK with platform 35 and build-tools 35 works.
sdkmanager --licenses
sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"

# Point the build at the SDK.
echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties

# Build, test, and install.
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
./gradlew :app:installDebug
```

`local.properties` and all build output are ignored by Git.

### Building on NixOS

Android Gradle Plugin downloads its own generic-Linux `aapt2`, which NixOS cannot
execute directly. Point AGP at the SDK's patched binary instead:

```sh
./gradlew :app:assembleDebug \
  -Pandroid.aapt2FromMavenOverride="$ANDROID_SDK_ROOT/build-tools/35.0.0/aapt2"
```

## Tests

```sh
./gradlew :app:testDebugUnitTest    # JVM unit tests for the pure logic
./gradlew :app:connectedDebugAndroidTest  # instrumentation, needs a device
```

The JVM unit tests cover the navigation policy (internal, external, and blocked
URLs, origin and port matching, cleartext, and unsafe schemes), the deep-link
policy, configuration parsing, bridge message parsing, and the app-lock policy.
The instrumentation test is a smoke test that an unconfigured build shows the
configuration error; it requires a device or emulator.

## Release signing

Release signing reads an out-of-band keystore. The keystore and passwords are
never committed; provide them through Gradle properties or environment
variables.

| Gradle property                  | Environment variable      |
| -------------------------------- | ------------------------- |
| `wickmail.release.keystore`      | `WICKMAIL_KEYSTORE`       |
| `wickmail.release.storePassword` | `WICKMAIL_STORE_PASSWORD` |
| `wickmail.release.keyAlias`      | `WICKMAIL_KEY_ALIAS`      |
| `wickmail.release.keyPassword`   | `WICKMAIL_KEY_PASSWORD`   |

```sh
./gradlew :app:bundleRelease \
  -Pwickmail.managementOrigin=https://wickmail.example.com \
  -Pwickmail.release.keystore=/secure/wickmail-release.jks \
  -Pwickmail.release.storePassword="$WICKMAIL_STORE_PASSWORD" \
  -Pwickmail.release.keyAlias=wickmail \
  -Pwickmail.release.keyPassword="$WICKMAIL_KEY_PASSWORD"
```

Without a configured keystore the release build is left unsigned rather than
falling back to a debug key.

## Distribution and updates

The chosen channel is **Google Play**, using a signed Android App Bundle
(`bundleRelease`) uploaded to internal testing first and promoted to production.
Play manages the signing key and delivers updates through the Play Store, so
users receive new versions without reinstalling.

Updates are published by incrementing `versionCode` in `app/build.gradle.kts`,
building a new signed bundle, and uploading it. The `versionName` is
informational. A signed APK from a release page is an acceptable fallback for
users who do not use Play, but Play is the primary channel and the supported
update path.

## Security model

- Only HTTPS is permitted. Cleartext traffic is disabled in the manifest and in
  the network security configuration, and the navigation policy never loads an
  `http` URL internally.
- Only the management origin and explicitly approved identity origins load in
  the WebView. Everything else opens in another app or is refused.
- Mixed content is disabled, file and content access are disabled, universal
  file-URL access is off, and WebView debugging is enabled only in debug builds.
- The bridge is optional and origin-scoped. It uses `addWebMessageListener`
  restricted to the exact management origin, exposes only copy, share, and the
  app-lock toggle, and never exposes cookies, tokens, or network primitives.
  When the WebView does not support the feature, the shell adds nothing and the
  web app's own copy and share behavior applies.
- The app lock is a local privacy gate and never replaces server authentication.
  Native code never reads, stores, or injects the user's password.
- App links accept only alias detail routes on approved hosts and never accept
  an arbitrary WebView destination.

## Behavior notes

- **Back navigation:** Android Back goes through WebView history before closing
  the app.
- **External links:** `http`, `https`, `mailto`, `tel`, and `sms` links open in
  another app. Unsafe schemes such as `javascript:`, `data:`, `file:`, and
  `content:` are refused.
- **Connectivity errors:** when the main document fails to load, the shell shows
  a native error with a retry that reloads the requested page. The shell keeps
  no offline copy of alias or quarantine data, so it cannot report a stale alias
  as newly created or renewed, and it never queues mutations or replies.
- **Unsent input:** rotation and other configuration changes do not recreate the
  Activity, so in-progress form input survives. The WebView state is saved and
  restored across process recreation as a best effort.
- **Copy and share:** the management page's copy and share controls use the
  native clipboard and share sheet where the WebView lacks a built-in
  implementation, with a confirmation.
- **App links:** `https://<host>/aliases/<id>` opens the alias detail route.
  The web app also uses the hash form `#/aliases/<id>`.

## Deferred

- Notifications for expiring aliases and quarantined mail are post-MVP per the
  design.
- The inbound share target that suggests a create label is optional in the
  design and is not implemented, because the management app has no route for a
  suggested label and the shell must not modify web behavior.

## Verification in this environment

Verified with a Nix-provided JDK 21, Gradle 8.14.4, and an Android SDK
(`platforms;android-35`, `build-tools;35.0.0`) assembled from `androidenv`:

- `gradle :app:testDebugUnitTest` — passed, 40 JVM unit tests.
- `gradle :app:assembleDebug :app:assembleRelease` — passed, producing
  `app-debug.apk` and `app-release-unsigned.apk`.
- The configured management origin, identity origins, and app-link host appear
  in the generated `BuildConfig` and the merged manifest.

The `-Pandroid.aapt2FromMavenOverride` flag above is required on NixOS. The
instrumentation tests were not run because no device or emulator is available.
