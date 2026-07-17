# Built installers land here

`cd desktop && npm install && npm run dist` (per-OS) drops installers into this
folder, and the site's Download page + /api/downloads pick them up automatically.
Files:  Empire-Meet-<version>-mac-<arch>.dmg / .zip, Empire-Meet-<version>-win-x64.exe,
Empire-Meet-<version>-linux.AppImage.

The recommended way to produce BOTH Mac and Windows installers without a Windows
machine is the GitHub Actions workflow in .github/workflows/build-desktop.yml.
