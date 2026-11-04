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
      });

      # Convenience runners are added as tasks are defined.
      apps = forAllSystems (_pkgs: { });

      nixosModules.default = _: { };
    };
}
