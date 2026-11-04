{
  description = "Wickmail: self-hosted email with programmable, expiring aliases";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      lib = nixpkgs.lib;

      # Path names that never belong in a source tree. Applied to every
      # per-language source filter so build inputs stay independent of local
      # build output and VCS metadata.
      ignoredNames = [
        ".direnv"
        ".git"
        "dist"
        "node_modules"
        "result"
        "target"
      ];

      perSystem =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib;

          # Node toolchain shared by the dev shell, checks, and packages.
          nodejs = pkgs.nodejs_24;

          # Android SDK packages are unfree and need the SDK license accepted
          # non-interactively. The SDK is x86_64-only in this environment, so
          # everything below is gated on that system.
          pkgsAndroid = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };

          androidSdk =
            (pkgsAndroid.androidenv.composeAndroidPackages {
              buildToolsVersions = [ "35.0.0" ];
              platformVersions = [ "35" ];
              includeEmulator = false;
              includeSystemImages = false;
              includeNDK = false;
              includeSources = false;
            }).androidsdk;

          androidSdkRoot = "${androidSdk}/libexec/android-sdk";
          androidAapt2 = "${androidSdkRoot}/build-tools/35.0.0/aapt2";

          # The Rust server workspace is self-contained.
          serverSrc = lib.cleanSourceWith {
            name = "wickmail-server-src";
            src = ./apps/server;
            filter = path: _type: !(builtins.elem (baseNameOf (toString path)) ignoredNames);
          };

          # The npm workspace spans the repository root plus the two packages.
          rootPath = toString ./.;
          webSrc = lib.cleanSourceWith {
            name = "wickmail-web-src";
            src = ./.;
            filter =
              path: type:
              let
                rel = lib.removePrefix (rootPath + "/") (toString path);
                topLevel = [
                  ".prettierignore"
                  "eslint.config.js"
                  "package-lock.json"
                  "package.json"
                  "prettier.config.js"
                  "tsconfig.base.json"
                ];
                workspaceDirs = [
                  "apps/web"
                  "packages/core"
                  "apps/server/crates/wickmail-server/fixtures"
                ];
              in
              if path == ./. then
                true
              else if builtins.elem (baseNameOf (toString path)) ignoredNames then
                false
              else if builtins.elem rel topLevel then
                true
              else if type == "directory" then
                lib.any (
                  dir: rel == dir || lib.hasPrefix (rel + "/") dir || lib.hasPrefix (dir + "/") rel
                ) workspaceDirs
              else
                lib.any (dir: lib.hasPrefix (dir + "/") rel) workspaceDirs;
          };

          # npm dependencies are fetched once and shared by every npm
          # derivation. Fetcher version 2 caches packuments, which npm
          # workspaces require.
          npmDepsFetcherVersion = 2;
          npmDepsHash = "sha256-1POv4LSTDC9ZFwW6vpy+ZlXit2GJDEHVL+cact/BuUc=";
          webNpmDeps = pkgs.fetchNpmDeps {
            name = "wickmail-web-npm-deps";
            src = webSrc;
            hash = npmDepsHash;
            fetcherVersion = npmDepsFetcherVersion;
          };

          wickmail-server = pkgs.rustPlatform.buildRustPackage {
            pname = "wickmail-server";
            version = "0.0.0";
            src = serverSrc;
            cargoLock.lockFile = ./apps/server/Cargo.lock;
            # `webauthn-rs` links OpenSSL for attestation certificate parsing.
            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = [ pkgs.openssl ];
            meta = {
              description = "Wickmail alias service, policy engine, and management API";
              license = lib.licenses.agpl3Only;
              mainProgram = "wickmail-server";
              platforms = lib.platforms.unix;
            };
          };

          # npm installs some workspace dependencies into per-workspace
          # `node_modules` directories, which the buildNpmPackage hook does not
          # patch. Patch every tree so `npm run` scripts resolve their binaries.
          patchShebangsNodeModules = ''
            for nodeModules in node_modules apps/*/node_modules packages/*/node_modules; do
              if [ -d "$nodeModules" ]; then
                patchShebangs "$nodeModules"
              fi
            done
          '';

          wickmail-web = pkgs.buildNpmPackage {
            pname = "wickmail-web";
            version = "0.0.0";
            src = webSrc;
            npmDeps = webNpmDeps;
            npmDepsFetcherVersion = npmDepsFetcherVersion;
            inherit nodejs;
            preBuild = patchShebangsNodeModules;
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/wickmail-web
              cp -r apps/web/dist/. $out/share/wickmail-web/
              runHook postInstall
            '';
            meta = {
              description = "Wickmail web management app";
              license = lib.licenses.agpl3Only;
              platforms = lib.platforms.unix;
            };
          };

          # Rust checks run against the workspace with a writable cargo home
          # and target directory. The scaffold has no dependencies, so the
          # checks stay offline.
          rustToolchain = with pkgs; [
            cargo
            clippy
            rustc
            rustfmt
          ];

          # Rust checks reuse the vendored Cargo dependencies so they build
          # offline. buildRustPackage installs the vendored sources and a
          # `.cargo/config.toml`; the check script replaces the build phase.
          mkRustCheck =
            name: script:
            pkgs.rustPlatform.buildRustPackage {
              pname = "wickmail-server-${name}";
              version = "0.0.0";
              src = serverSrc;
              cargoLock.lockFile = ./apps/server/Cargo.lock;
              nativeBuildInputs = rustToolchain ++ [ pkgs.pkg-config ];
              buildInputs = [ pkgs.openssl ];
              doCheck = false;
              buildPhase = ''
                runHook preBuild
                export CARGO_HOME="$TMPDIR/cargo-home"
                export CARGO_TARGET_DIR="$TMPDIR/cargo-target"
                ${script}
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                mkdir -p $out
                touch $out/passed
                runHook postInstall
              '';
            };

          # npm checks reuse the prefetched dependency cache. Each check runs
          # one workspace script so a failure names the tool that failed.
          mkNpmCheck =
            name: command:
            pkgs.buildNpmPackage {
              pname = "wickmail-web-${name}";
              version = "0.0.0";
              src = webSrc;
              npmDeps = webNpmDeps;
              npmDepsFetcherVersion = npmDepsFetcherVersion;
              inherit nodejs;
              dontNpmBuild = true;
              preBuild = patchShebangsNodeModules;
              buildPhase = ''
                runHook preBuild
                ${command}
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                mkdir -p $out
                echo ${name} > $out/check
                runHook postInstall
              '';
            };

          # JUnit and Hamcrest for the pure-logic Kotlin check. Fixed-output
          # fetches are allowed to reach the network inside the sandbox.
          junit = pkgs.fetchMavenArtifact {
            groupId = "junit";
            artifactId = "junit";
            version = "4.13.2";
            sha256 = "sha256-jklbY0Rp1k+4rPo0laBly6zIoP/1XOHjEAe+TBbcV9M=";
          };

          hamcrest = pkgs.fetchMavenArtifact {
            groupId = "org.hamcrest";
            artifactId = "hamcrest-core";
            version = "1.3";
            sha256 = "sha256-Zv3vkelzk0jfeglqo4SlaF9Oh1WEzOiThqekclHE2Ok=";
          };

          # Offline structural verification of the Android project. The full
          # APK build needs network for Gradle and Maven, so it runs in the dev
          # shell instead; this check enforces the security invariants that
          # must never regress.
          androidShell =
            pkgs.runCommand "wickmail-android-shell"
              {
                nativeBuildInputs = [ pkgs.gnugrep ];
              }
              ''
                src=${./apps/android}
                manifest="$src/app/src/main/AndroidManifest.xml"
                network="$src/app/src/main/res/xml/network_security_config.xml"
                wrapper="$src/gradle/wrapper/gradle-wrapper.properties"
                appGradle="$src/app/build.gradle.kts"
                kotlin="$src/app/src/main/kotlin/com/wickmail/android"

                fail() {
                  echo "android-shell check failed: $1" >&2
                  exit 1
                }

                grep -q 'android:usesCleartextTraffic="false"' "$manifest" \
                  || fail "the manifest must disable cleartext traffic"
                grep -q 'android:networkSecurityConfig=' "$manifest" \
                  || fail "the manifest must set a network security config"
                grep -q 'android.permission.INTERNET' "$manifest" \
                  || fail "the manifest must request the internet permission"
                grep -q 'cleartextTrafficPermitted="false"' "$network" \
                  || fail "the network security config must disable cleartext"
                grep -q 'android:autoVerify="true"' "$manifest" \
                  || fail "app links must opt into verification"
                grep -q 'android:pathPrefix="/aliases/"' "$manifest" \
                  || fail "app links must be scoped to alias details"
                grep -q 'distributionSha256Sum=' "$wrapper" \
                  || fail "the Gradle wrapper must pin a distribution checksum"
                grep -q 'compileSdk = 35' "$appGradle" \
                  || fail "compileSdk must be pinned"
                grep -q 'minSdk = 26' "$appGradle" \
                  || fail "minSdk must be pinned"
                grep -q 'setWebContentsDebuggingEnabled(BuildConfig.DEBUG)' "$kotlin/MainActivity.kt" \
                  || fail "WebView debugging must be limited to debug builds"
                grep -q 'MIXED_CONTENT_NEVER_ALLOW' "$kotlin/MainActivity.kt" \
                  || fail "mixed content must be disabled"
                grep -q 'allowFileAccess = false' "$kotlin/MainActivity.kt" \
                  || fail "file access must be disabled"

                if grep -rq 'addJavascriptInterface' "$kotlin"; then
                  fail "the shell must not expose a general JavaScript interface"
                fi

                touch "$out"
              '';

          # Compiles and runs the pure navigation and deep-link logic with the
          # JVM test suite. This needs no Android SDK and no network.
          androidLogic =
            pkgs.runCommand "wickmail-android-logic"
              {
                nativeBuildInputs = [
                  pkgs.kotlin
                  pkgs.jdk17
                ];
              }
              ''
                export JAVA_HOME=${pkgs.jdk17.home}
                work="$TMPDIR/logic"
                mkdir -p "$work"
                cp ${./apps/android/app/src/main/kotlin/com/wickmail/android/OriginPolicy.kt} "$work/"
                cp ${./apps/android/app/src/main/kotlin/com/wickmail/android/DeepLinks.kt} "$work/"
                cp ${./apps/android/app/src/test/kotlin/com/wickmail/android/OriginPolicyTest.kt} "$work/"
                cp ${./apps/android/app/src/test/kotlin/com/wickmail/android/DeepLinksTest.kt} "$work/"
                cat > "$work/Runner.kt" <<'RUNNER'
                package com.wickmail.android

                import org.junit.runner.JUnitCore

                fun main() {
                    val result = JUnitCore.runClasses(OriginPolicyTest::class.java, DeepLinksTest::class.java)
                    result.failures.forEach { failure ->
                        System.err.println(failure.toString())
                        failure.exception.printStackTrace()
                    }
                    check(result.wasSuccessful()) {
                        result.failureCount.toString() + " of " + result.runCount + " tests failed"
                    }
                    println(result.runCount.toString() + " android logic tests passed")
                }
                RUNNER
                kotlinc "$work"/*.kt -cp "${junit.jar}:${hamcrest.jar}" -include-runtime -d "$work/tests.jar"
                java -cp "$work/tests.jar:${junit.jar}:${hamcrest.jar}" com.wickmail.android.RunnerKt
                touch "$out"
              '';

          checks = {
            rust-fmt = mkRustCheck "fmt" "cargo fmt --all --check";
            rust-clippy = mkRustCheck "clippy" "cargo clippy --all-targets --all-features --locked --offline -- -D warnings";
            rust-test = mkRustCheck "test" "cargo test --all-targets --all-features --locked --offline";

            web-svelte-check = mkNpmCheck "svelte-check" "npm run check --workspace=@wickmail/web";
            web-core-check = mkNpmCheck "core-check" "npm run check --workspace=@wickmail/core";
            web-prettier = mkNpmCheck "prettier" "npm run format:check";
            web-eslint = mkNpmCheck "eslint" "npm run lint";
            web-test = mkNpmCheck "test" "npm run test";
            web-build = mkNpmCheck "build" "npm run build --workspace=@wickmail/web";

            nix-fmt =
              pkgs.runCommand "wickmail-nix-fmt"
                {
                  nativeBuildInputs = [ pkgs.nixfmt ];
                }
                ''
                  nixfmt --check ${./flake.nix} ${./nix/modules/default.nix} ${./nix/tests/mail-path.nix}
                  touch $out
                '';
          }
          // lib.optionalAttrs (system == "x86_64-linux") {
            android-shell = androidShell;
            android-logic = androidLogic;
          };

          serverApp = {
            type = "app";
            program = "${wickmail-server}/bin/wickmail-server";
            meta = {
              description = "Run the Wickmail server";
            };
          };

          devShell = pkgs.mkShell {
            packages = [
              # Rust server toolchain.
              pkgs.cargo
              pkgs.clippy
              pkgs.rust-analyzer
              pkgs.rustc
              pkgs.rustfmt
              # Web and client toolchain.
              nodejs
              # Mail-path tooling used by the integration harness.
              pkgs.postfix
              pkgs.dovecot
              pkgs.rspamd
              pkgs.swaks
              pkgs.openssl
              pkgs.pkg-config
              pkgs.sqlite
              # Nix formatting.
              pkgs.nixfmt
            ]
            ++ lib.optionals (system == "x86_64-linux") [
              # Android shell toolchain. Gradle comes from the wrapper.
              pkgs.jdk17
              androidSdk
            ];

            shellHook = ''
              echo "Wickmail development shell"
              echo "  rustc: $(rustc --version)"
              echo "  cargo: $(cargo --version)"
              echo "  node:  $(node --version)"
              echo "  npm:   $(npm --version)"
            ''
            + lib.optionalString (system == "x86_64-linux") ''
              export ANDROID_HOME=${androidSdkRoot}
              export ANDROID_SDK_ROOT=${androidSdkRoot}
              # NixOS cannot run the aapt2 that AGP downloads from Maven; use
              # the SDK's patched aapt2 instead.
              export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidAapt2}"
              echo "  android: ${androidSdkRoot}"
            '';
          };
        in
        {
          inherit
            checks
            devShell
            wickmail-server
            wickmail-web
            ;

          packages = {
            inherit wickmail-server wickmail-web;
            default = wickmail-server;
          };

          apps = {
            server = serverApp;
            default = serverApp;
          };

          formatter = pkgs.nixfmt;
        };

      all = lib.genAttrs systems perSystem;
    in
    {
      packages = lib.mapAttrs (_: value: value.packages) all;
      devShells = lib.mapAttrs (_: value: { default = value.devShell; }) all;
      checks = lib.mapAttrs' (
        system: value:
        lib.nameValuePair system (
          value.checks
          // lib.optionalAttrs (system == "x86_64-linux") {
            mail-path = import ./nix/tests/mail-path.nix {
              pkgs = import nixpkgs { inherit system; };
              wickmailModule = self.nixosModules.default;
            };
          }
        )
      ) all;
      apps = lib.mapAttrs (_: value: value.apps) all;
      formatter = lib.mapAttrs (_: value: value.formatter) all;

      nixosModules.default = import ./nix/modules/default.nix { inherit self; };
    };
}
