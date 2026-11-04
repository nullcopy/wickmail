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

          checks = {
            rust-fmt = mkRustCheck "fmt" "cargo fmt --all --check";
            rust-clippy = mkRustCheck "clippy" "cargo clippy --all-targets --all-features --locked --offline -- -D warnings";
            rust-test = mkRustCheck "test" "cargo test --all-targets --all-features --locked --offline";

            web-svelte-check = mkNpmCheck "svelte-check" "npm run check --workspace=@wickmail/web";
            web-core-check = mkNpmCheck "core-check" "npm run check --workspace=@wickmail/core";
            web-prettier = mkNpmCheck "prettier" "npm run format:check";
            web-eslint = mkNpmCheck "eslint" "npm run lint";
            web-test = mkNpmCheck "test" "npm run test --workspace=@wickmail/core";
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
            ];

            shellHook = ''
              echo "Wickmail development shell"
              echo "  rustc: $(rustc --version)"
              echo "  cargo: $(cargo --version)"
              echo "  node:  $(node --version)"
              echo "  npm:   $(npm --version)"
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
