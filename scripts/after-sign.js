/**
 * electron-builder's afterSign hook, which lets Squirrel.Mac install updates
 * to an app signed ad hoc.
 *
 * Squirrel.Mac installs an update only if it satisfies the running app's
 * designated requirement. An ad-hoc signature's is the app's own hash, which
 * no later build matches, so it would reject every update. This signs the app
 * bundle again, ad hoc as before, with the bundle ID as its designated
 * requirement, which every later build meets. mac.requirements in
 * electron-builder.yml can't do it: electron-builder gives the requirement to
 * every binary in the bundle too, which then fail its own verification.
 *
 * Squirrel's check then proves nothing, since any app can claim the bundle ID.
 * An update rests on HTTPS and on the SHA-512 in latest-mac.yml instead, as on
 * Windows, where an unsigned installer gets no signature check either.
 *
 * electron-builder runs the hook after signing and before it makes the zip
 * and the DMG, and only for what it signed: on macOS. It warns that it skips
 * the hook for the Windows and Linux builds, which it doesn't sign.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

/** @param {import("app-builder-lib").AfterPackContext} context */
export default function afterSign({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== "darwin") return;
  const bundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      // Keep what electron-builder signed it with: the bundle ID, the
      // entitlements, and the hardened runtime.
      "--preserve-metadata=identifier,entitlements,flags,runtime",
      "--requirements",
      `=designated => identifier "${packager.appInfo.id}"`,
      bundle,
    ],
    { stdio: "inherit" },
  );
  // The binaries inside keep their own signatures, which must still hold.
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
}
