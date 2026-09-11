# Browser action reliability

DSH Patrol separates **page understanding** from the **last-mile browser mutation**.

For semantic clicks, `patrol_click_target` now uses one atomic browser-extension command that resolves the CURRENT target across accessible frames and clicks it immediately in the page MAIN world. This avoids the previous snapshot-to-click race where a React/Vue re-render, iframe replacement, or content-script reconnect could invalidate a selector after analysis but before the click.

If the atomic transport is temporarily unavailable, the same composite action
may fall back once to a selector hint already observed on the CURRENT page. It
binds the hint against a fresh CURRENT snapshot, re-counts visible matches,
and only clicks when that selector is uniquely matched to the semantic locator;
ambiguous, stale, or unobserved selectors still fail closed. This prevents the model
from creating a second, duplicate business-click attempt just to recover a
transient extension error.

The reusable Runbook still stores an ordinary `browser_click` step using the selector that was actually clicked. This preserves deterministic replay and selector healing while keeping the atomic semantic primitive internal to Patrol.

## Draft Runbook policy

A DRAFT inspection is the reusable business flow, not a transcript of debugging calls. When a `taskChecklist` exists, transient observations such as snapshots, counts, arbitrary waits, scroll probes, and unreferenced login/challenge checks are filtered out of the stored DRAFT. Page reads and screenshots are kept only when their step names correspond to user-requested checklist work. Failed or explicitly unverified clicks are never eligible.

This means a stuck teaching session can keep rich diagnostic evidence in the conversation/runtime without polluting the flow graph with steps that did not complete a checklist item.

## Login-state policy

Absence of a password field is not authentication evidence. `browser_login_state` reports `authenticated` only when positive application controls such as logout/workbench/dashboard indicators are visible. Portal shells, splash screens, and logo-only pages therefore remain `unknown` instead of being incorrectly treated as authenticated.
