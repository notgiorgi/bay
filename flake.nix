{
  description = "bay - a Bun CLI for acquiring and tracking local development ports";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        bay = pkgs.stdenvNoCC.mkDerivation {
          pname = "bay";
          version = "0.1.0";
          src = ./.;

          nativeBuildInputs = [
            pkgs.bun
          ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            bun build ./index.ts --compile --outfile bay
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 bay "$out/bin/bay"
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "A Bun CLI for acquiring and tracking local development ports";
            homepage = "https://github.com/notgiorgi/bay";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "bay";
          };
        };
      in
      {
        packages.default = bay;
        packages.bay = bay;

        apps.default = {
          type = "app";
          program = "${bay}/bin/bay";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.git
          ];
        };
      }
    );
}
