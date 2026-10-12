# LiftLog 2.0

Prepared 12 October 2026 for the existing GitHub Pages address.

## Included

- Durable workout storage, unfinished workout and logger drafts, recovery,
  validated offline downloads, and updates that wait until editing is safe.
- A consistent routine-card start flow; the complete exercise list with muscle
  colours; drag reordering; an animated workout progress rail.
- Separate Library exercise/routine views, routine editing and reordering,
  exercise editing, themed picker, and removal confirmations.
- A compact logger with exercise swaps within a muscle, the selected copy icon,
  weight-only copying of previous sets, a full-width add-set button, and notes.
- Separate external, bodyweight, assisted and weighted exercise histories;
  bodyweight snapshots with their source date and recorded load estimates.
- Expandable workout history and editing completed workouts, including duration,
  exercises, weights, reps and notes.
- The calendar, muscle colours, bodyweight and exercise-progress charts,
  date-range filtering, primary-muscle workout breakdown, and sliding selectors.
- Month reviews in Stats, a one-time reveal per month, and previous month reviews.
- Light, Dark and Lilac Paper themes; purple-only female recap illustrations.
  All artwork is bundled for offline use.

Weekly streaks, calendar alerts, quarterly/yearly reviews, and account/device sync
are future ideas, not features in this release.

## iPhone acceptance before the first gym session

Use the original Home Screen icon for an existing installation. Do not remove it,
clear Safari data, or restore a backup just to update.

1. While online, open LiftLog and check that your Library and April history are
   still present. If they are missing, stop and check the address/installation.
2. In Settings, wait for offline access to report ready. Turn on airplane mode
   with Wi-Fi off, close the app, and reopen its Home Screen icon.
3. Start a Freestyle workout and add an exercise. Enter a weight and an exercise
   note with reps still blank. Close and reopen the app; resume and check them.
4. Enter reps, save the sets and finish the workout. Confirm it in History, then
   edit its duration. If this was only a test, delete that test workout using the
   confirmation dialog.
5. Return online. Check Light, Dark and Purple, the Library switch, Stats filters
   and a month review. Existing month reviews should reopen without repeating
   their reveal.

Desktop and automated tests do not certify a physical iPhone. This checklist
checks the installed app, storage and iOS offline behavior that cannot be inferred
from static validation alone.

## Sharing

Send https://knappy-boy.github.io/workout/ to another person. They add it to their
own Home Screen and create their own exercise library/routines. Their data remains
in their own browser's storage. Do not send your workout JSON unless you intend to
share its contents.
