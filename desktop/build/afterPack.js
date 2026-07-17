// electron-builder afterPack hook.
//
// We build unsigned (no Apple Developer identity), but on macOS — especially
// Apple Silicon — an app must carry a VALID signature or Gatekeeper refuses to
// launch it ("damaged, move to Trash"). electron-builder adds our resources
// (app.asar, injector.py, agent/) into the bundle after Electron's own
// signature, which invalidates it. So we re-apply a fresh ad-hoc signature that
// actually covers the final bundle. Ad-hoc = launchable (with the one-time
// right-click → Open), just not notarized.
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log("[afterPack] ad-hoc re-signing", app);
  // Sign inner code first (--deep) with the ad-hoc identity ("-").
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  // Sanity check — fail the build if the signature doesn't validate.
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log("[afterPack] signature verified OK");
};
