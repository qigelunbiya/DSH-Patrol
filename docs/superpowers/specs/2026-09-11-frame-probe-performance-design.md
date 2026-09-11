# Frame probe performance design

## Goal

Reduce latency for iframe-heavy Patrol pages without weakening target safety. The
frame bridge currently probes child documents serially for snapshots, page reads,
counts, and selector discovery. A portal with several frames therefore pays the
full bridge round-trip for each frame before the model can act.

## Design

Add one small, deterministic bounded-concurrency helper inside
`browser-extension/frame-support.js`. Snapshot, page-read, count, and wait
frame work runs with at most four active `chrome.tabs.sendMessage` calls.
Results retain the original frame order inside the helper; `browser_read_page`
may still sort completed blocks by structured-table richness before rendering.
A failed frame contributes an empty/ignored result exactly as it does today.

Snapshot probes receive only the remaining top-document budget (with a minimum
of one element) rather than requesting the full global limit from every frame.
This keeps each concurrent request bounded while the final aggregation still
clips the observable snapshot to the requested maximum.

Use the helper for snapshot collection, page reads, cross-frame counts, and
wait probes. The separate MAIN-world recovery layer in
`frame-resilient.js` remains a bounded last-mile fallback and is intentionally
out of scope for this change. Keep mutations strict and unchanged: selector
resolution still requires exactly one visible match across eligible frames, and
the semantic-click MAIN-world path remains the authoritative atomic click route.

## Verification

Add regression tests with delayed child-frame responses. They must observe more
than one request in flight and never more than four, proving both concurrency
and the cap, while existing tests continue to verify stable structured-table
ordering, frame-qualified selectors, and unique-target enforcement. Run the full
Vitest suite, typecheck, extension checks, and build before committing and
pushing.
