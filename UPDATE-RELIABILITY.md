# Home Screen app updates

LiftLog stores workout records and unfinished workout drafts separately from the
service worker's downloaded application files. Updating the repository or app
files does not require exporting and reimporting a JSON backup. Keep publishing
to the same HTTPS address: browser storage belongs to that site. Changing the
hostname, moving to a different browser/installation, clearing website data or
removing the installation can make the old storage unavailable. JSON export is
still useful as a separate backup, not as an update step.

## How publishing reaches the phone

After the changed files have reached the existing static host, LiftLog checks for
new files on launch, after returning to the app (at most once per five minutes),
and when its connection returns. It hashes the complete application, including
the worker itself; no cache version needs to be edited, no build step is required,
and no phone-side refresh/install procedure is needed. The app cannot download
while the phone is offline or while iOS has suspended it. A repository push only
publishes when the repository's existing hosting is configured to deploy it.

The small application is downloaded and checked as a complete release before it
becomes available offline. Failed responses, HTML returned instead of JavaScript,
and files changing during deployment reject the candidate. The current cached
release remains available. Every open LiftLog window must finish its active
workout and any open edit before the new release activates. Idle windows briefly
lock their controls during activation, preventing a new edit from racing a reload.
If any window refuses or does not respond, the update waits. Finishing the workout
or reopening the app later retries it automatically. Old versions predating this
handshake must be closed before a waiting release can activate.

Only LiftLog app-shell caches are cleaned up. No workout storage is cleared by
update code. Runtime shell requests are cache-first, so a disconnected app keeps
one internally consistent release. Unrecognised requests are not cached and do
not receive HTML as a false successful response.

## Offline setup and recovery

Saving workout data and installing the offline app are separate operations.
Settings shows offline setup phases, completed files, downloaded bytes and elapsed
time. It reports readiness only after verifying the complete cache and confirming
that a service worker controls this window. There is no estimated completion time.
Downloads use at most three simultaneous requests, with bounded timeouts and
limited automatic retries. A failed setup offers **Retry download** while online.

An incomplete cache is repaired at the same address without clearing workout
storage or unregistering the worker. A recovery page can bootstrap repair when
the cached app cannot start. The user should not need to remove the Home Screen
icon or clear Safari data. Actual iPhone offline launch and scrolling still need
device validation; desktop browser and automated checks do not replace that.

Normal successful saving is quiet in the main app. Save failures remain visible.
The isolated TEST preview also shows successful save status inside the exercise
logger so the phone checklist can be followed while entering sets. Its optional
downloaded report contains bounded diagnostic events, setup stages, file counts
and safe error codes, but no workout weights or notes. It is stored locally and
is not uploaded automatically.

## Developer integration

Load `theme-runtime.js`, `storage.js`, `dates.js`, `logging.js`, and `updates.js` before `app.js`.
The appearance preference cycles Light → Dark → Purple, with Lilac Paper as the
purple palette. It is saved through the existing workout store; theme switching
keeps unfinished sets and notes. Existing light/dark preferences and storage keys
remain intact. Both new theme assets belong in the offline asset manifest.
Remove the old inline service-worker registration. At the end of app setup call:

```js
LiftLogUpdates.configure({
  canReload: () => /* no active workout, unsaved draft, modal, or pending save */,
  prepareForUpdate: async () => {
    // Check safety again, synchronously lock new UI interaction, then return true.
  },
  cancelUpdate: () => { /* release the temporary UI lock */ },
  onStatus: ({ state, detail }) => { /* optional unobtrusive settings status */ }
});
```

`canReload` reports data/edit safety; it must not reject because of the temporary
update lock itself. Call `LiftLogUpdates.notifySafe()` after completing a workout,
closing an edit, or completing a pending save. `LiftLogUpdates.check()` explicitly
checks for changes. New required app files must be added to the marked JSON asset array in
`sw.js`. Keep the manifest markers intact: older updaters read this fresh manifest
to discover future files without a build step.

Run `node --test tests/service-worker.test.cjs tests/updates.test.cjs` to check
release integrity, server failure, offline cache use, cache scope, update approval,
and the client reload guard. Browser checks should additionally stage two builds
at the same local origin, leave a workout open, change an asset, and verify that
the new version appears only after safely finishing while history remains intact.
The first transition from the old v35 worker uses that old version's network-first
behaviour until this new worker takes over. Subsequent releases use the complete,
validated release mechanism described above.
