# Frame probe performance design

## Goal

Reduce latency for iframe-heavy Patrol pages without weakening target safety. The
frame bridge currently probes child documents serially for snapshots, page reads,
counts, and selector discovery. A portal with several frames therefore pays the
full bridge round-trip for each frame before the model can act.

## Design

Add one small, deterministic bounded-concurrency helper inside
`browser-extension/frame-support.js`. Frame work runs with at most four active
`chrome.tabs.sendMessage` calls. Results retain the original frame order, and a
failed frame contributes an empty/ignored result exactly as it does today.

Use the helper for snapshot collection, page reads, cross-frame counts, and the
fallback frame discovery path. Keep mutations strict and unchanged: selector
resolution still requires exactly one visible match across eligible frames, and
the semantic-click MAIN-world path remains the authoritative atomic click route.

## Verification

Add a regression test with two delayed child-frame responses. It must observe
more than one request in flight, proving the probe is concurrent, while existing
tests continue to verify stable structured-table ordering, frame-qualified
selectors, and unique-target enforcement. Run the full Vitest suite, typecheck,
extension checks, and build before committing and pushing.
