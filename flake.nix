{
  description = "Wickmail: self-hosted email with programmable, expiring aliases";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (nixpkgs.legacyPackages.${system}));

      # Project source without build output or VCS metadata, so the checks see
      # only project files.
      source = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter =
          path: _type:
          let
            name = baseNameOf path;
          in
          !(builtins.elem name [
            ".direnv"
            ".git"
            "node_modules"
            "result"
          ]);
      };
    in
    {
      # Application packages are added as code lands.
      packages = forAllSystems (_pkgs: { });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            prettier
            eslint
            jq
            sqlite
            curl
            openssl
            git
            socat
          ];
        };
      });

      checks = forAllSystems (pkgs: {
        formatting = pkgs.runCommand "wickmail-formatting-check" {
          nativeBuildInputs = [ pkgs.prettier ];
        } ''
          cp -R ${source} source
          chmod -R u+w source
          cd source
          export HOME="$TMPDIR"
          prettier --check .
          touch "$out"
        '';

        lint = pkgs.runCommand "wickmail-lint-check" {
          nativeBuildInputs = [ pkgs.eslint ];
        } ''
          cp -R ${source} source
          chmod -R u+w source
          cd source
          export HOME="$TMPDIR"
          eslint .
          touch "$out"
        '';

        # Evaluate the NixOS module against a sample configuration. This
        # resolves Postfix, Rspamd, and Dovecot settings without building the
        # full mail stack.
        nixos-modules =
          let
            evaluated = nixpkgs.lib.nixosSystem {
              system = pkgs.stdenv.hostPlatform.system;
              modules = [
                self.nixosModules.default
                self.nixosModules.wickmail-backup
                ./infra/nixos/test-configuration.nix
              ];
            };
            mail = evaluated.config.services.wickmail.mail;
          in
          pkgs.runCommand "wickmail-nixos-module-eval" { } ''
            cat > $out <<EOF
            domain=${mail.domain}
            virtual_transport=${evaluated.config.services.postfix.settings.main.virtual_transport}
            postfix=${toString evaluated.config.services.postfix.enable}
            rspamd=${toString evaluated.config.services.rspamd.enable}
            dovecot=${toString evaluated.config.services.dovecot2.enable}
            policy_socket=${mail.policySocket}
            lmtp_socket=${mail.lmtpSocket}
            EOF
          '';

        # Parse-check the operational scripts. They are run on the host, not
        # built here, so a syntax check is the cheap guard that CI can run.
        backup-scripts =
          pkgs.runCommand "wickmail-backup-scripts-check"
            {
              nativeBuildInputs = [ pkgs.bash ];
            }
            ''
              cp -R ${source} source
              chmod -R u+w source
              cd source
              for script in infra/scripts/*.sh; do
                bash -n "$script"
              done
              touch "$out"
            '';
      });

      # Convenience runners are added as tasks are defined.
      apps = forAllSystems (_pkgs: { });

      nixosModules = {
        default = import ./infra/nixos/wickmail-mail.nix;
        wickmail-mail = import ./infra/nixos/wickmail-mail.nix;
        wickmail-backup = import ./infra/nixos/wickmail-backup.nix;
      };
    };
}
