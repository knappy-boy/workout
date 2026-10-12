# LiftLog

An offline-capable workout tracker for the iPhone Home Screen.

**Use the app:** https://knappy-boy.github.io/workout/

Open that address in Safari, choose **Share → Add to Home Screen**, then open the
Home Screen icon. While online, wait until **Settings → Offline access** says the
app is ready before trying an offline launch.

Workouts, unfinished sets, exercise notes, routines and bodyweight entries stay
in that browser's storage on that device. They are not uploaded to GitHub or shared
with other visitors. A new installation starts empty: create exercises in Library
or from the workout exercise picker, and optionally build routines in Library.
There is no account or automatic sync between devices. Do not clear website data
or remove an existing installation as an update procedure. Export an occasional
JSON backup for recovery from a lost phone or cleared storage.

## Upgrading the original app

Keep using the existing address and Home Screen icon. Finish any workout in the
original app and close its open windows before the first upgrade. LiftLog imports
the original local data once into its durable store and retains the original bytes
as a recovery copy. It does not require importing a backup on each update.

If your original app has records but the updated app appears empty, stop before
logging or restoring anything. Check that you opened the original Home Screen
icon at the original address; Safari and installations can have separate stores.
Use the saved JSON backup if recovery is needed.

Later updates download when the app is open online. The downloaded release is
validated and waits for active workouts, editors and pending writes to finish
before activating. See [UPDATE-RELIABILITY.md](UPDATE-RELIABILITY.md).

## Versions and development

The original implementation is preserved at commit
`6f9a83a8e0279e2f49a3f6357e30b1f3c56a7a63` and the `archive/v1-original` branch.
That branch is a code archive; only `main` is published to GitHub Pages. Reverting
to the original code is not a complete data rollback: its old storage view will
not contain workouts saved by the new version. Export current data before any
recovery or rollback work.

This release contains the production application only. The temporary phone
preview and comparison site's fictional histories and diagnostics are separate.
`test-data.json` is an existing synthetic test fixture; the application never
loads it. No personal workout backup belongs in this repository.

To validate changes locally, use Node.js 18 or newer:

```sh
npm ci
npm run check
npm test
```

GitHub Pages currently publishes the repository root on `main`. Publishing the
complete commit updates the existing website. Add every required runtime file to
the marked asset array in `sw.js`; the updater derives versions from actual file
contents. There is no manual cache-version bump or phone reinstallation step.

See [RELEASE.md](RELEASE.md) for the implemented features and phone acceptance
checklist.
