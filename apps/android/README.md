# wickmail-android

Android WebView shell that hosts the Wickmail web management app, implemented in Kotlin with Gradle.

The shell is a thin client: it renders the same web app served by the management API and adds only native conveniences. Alias generation, leases, reply-identity selection, and quarantine operations stay on the server, and the shell never evaluates them.

See the [Android WebView shell design](../../docs/design/android.md), [ADR 0013](../../docs/decisions/0013-typescript-svelte-web-app.md), and [ADR 0014](../../docs/decisions/0014-android-distribution.md).

## What the shell provides

- A full-screen WebView for the configured HTTPS management origin.
- Back navigation through WebView history before the app closes.
- External links open in the user's browser; approved identity origins open internally.
- A native connectivity error with a retry.
- Native copy and share, exposed through a management-origin-scoped message bridge.
- Validated app links that open alias details, and a share target that opens the create dialog with a suggested label.
- An optional biometric app lock that degrades gracefully when the device cannot authenticate.

## Layout

```
app/src/main/kotlin/com/wickmail/android/
  MainActivity.kt         Activity, WebView setup, navigation, back, errors, deep links
  OriginPolicy.kt         Which origins load internally (pure Kotlin)
  DeepLinks.kt            App-link validation (pure Kotlin)
  AppConfig.kt            Build-time configuration
  NativeBridge.kt         Copy, share, and app-lock message bridge
  ConnectivityMonitor.kt  Online/offline reporting
  AppLockController.kt    Optional biometric lock
app/src/test/kotlin/       JVM tests for the pure logic
```

## Configuration

Both values are Gradle properties; set them on the command line or in `gradle.properties`.

| Property | Default | Purpose |
| --- | --- | --- |
| `wickmailManagementOrigin` | `https://wickmail.example` | The HTTPS origin hosted in the WebView. |
| `wickmailIdentityOrigins` | empty | Comma-separated HTTPS origins whose sign-in pages may load internally. |

`wickmailManagementOrigin` also sets the app-link host. To receive verified app links for a host you control, serve a Digital Asset Links file at `https://<host>/.well-known/assetlinks.json` listing this app's package name and signing certificate.

Example:

```
./gradlew assembleDebug -PwickmailManagementOrigin=https://mail.example.org
```

## Building

Everything runs through Nix. The dev shell provides the JDK, the Android SDK, and the environment variables the build needs:

```
nix develop
cd apps/android
./gradlew assembleDebug
```

The dev shell sets `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and `GRADLE_OPTS`. The `GRADLE_OPTS` value points AGP at the SDK's patched `aapt2`, because NixOS cannot run the generic `aapt2` binary that AGP downloads from Maven. The Gradle wrapper downloads Gradle itself, so the first build needs network access.

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. Debug builds use the application ID `com.wickmail.android.debug` so they can be installed alongside a release build.

## Verification

Offline checks run without the Android SDK or network:

```
nix build .#checks.x86_64-linux.android-shell .#checks.x86_64-linux.android-logic
```

- `android-shell` asserts the security invariants in the manifest, resources, wrapper, and WebView configuration.
- `android-logic` compiles the pure navigation and deep-link logic with `kotlinc` and runs the JVM test suite.

Inside the dev shell, the full Gradle test suite and lint run too:

```
cd apps/android
./gradlew testDebugUnitTest lint
```

## Release signing

Release builds are signed when a `keystore.properties` file exists next to `settings.gradle.kts`. Copy `keystore.properties.example` and point it at an upload keystore:

```
keytool -genkeypair -v -keystore release.keystore -alias wickmail \
  -keyalg RSA -keysize 4096 -validity 10000
```

`keystore.properties` and `*.keystore` are git-ignored. Keep the keystore and its passwords backed up: the same key must sign every update, and losing it prevents existing installs from upgrading.

Build a signed release bundle and APK with:

```
./gradlew bundleRelease assembleRelease
```

## Distribution and update path

See [ADR 0014](../../docs/decisions/0014-android-distribution.md). Releases are published on the repository's GitHub Releases page as a signed APK and AAB produced by `.github/workflows/android-release.yml` on a version tag. Users install the signed APK; Android rejects an update signed with a different key. Automatic updates can be added by publishing the same signed builds to an F-Droid repository or Google Play.

## Verification limits in the Nix sandbox

`nix flake check` does not build the APK. The Gradle build resolves the Android Gradle Plugin and AndroidX from Maven and downloads the Gradle distribution, and Nix builds are sandboxed without network, so the dependency graph cannot be fetched inside the check. The `android-shell` and `android-logic` checks cover the security-critical logic offline; the full debug build is verified in the dev shell as shown above and in CI.
