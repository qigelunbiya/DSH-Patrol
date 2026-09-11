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

The extension handshake now advertises `semanticClick` explicitly. Browser
diagnostics distinguish a registered host tool from a live extension that can
actually execute the command. When an older persistent profile lacks that
capability, Patrol fails fast and uses the same unique-selector composite
instead of repeatedly sending an unsupported command. The semantic layer also
loads immediately after the core bridge, so a failure in an unrelated optional
frame/compatibility layer cannot silently remove click support.

Selector fallback keeps exact selector and visible-count requirements, but its
text binding accepts a meaningful label contained in the CURRENT accessible
name (for example `登录` against `登录自助服务平台`). One-character fuzzy matches,
ambiguous selectors, stale selectors, and role/tag mismatches still fail closed.

The page-planning guard no longer counts pre-execution tool calls as completed
click attempts. Transport failures that never performed a physical click do not
consume the business retry budget. An executed click whose result could not be
verified is tracked separately: Patrol requires fresh CURRENT analysis before
one recovery retry and blocks a third physical click. Raw CSS clicks still
require page analysis.

Checklist enforcement now happens against persisted state at the teaching tool
and store boundary, rather than speculative guard memory. A failed duplicate-ID
create call therefore cannot poison an existing DRAFT, while a real new DRAFT
still cannot execute or append browser steps until its checklist is persisted.

The reusable Runbook still stores an ordinary `browser_click` step using the selector that was actually clicked. This preserves deterministic replay and selector healing while keeping the atomic semantic primitive internal to Patrol.

## Draft Runbook policy

A DRAFT inspection is the reusable business flow, not a transcript of debugging calls. When a `taskChecklist` exists, transient observations such as snapshots, counts, arbitrary waits, scroll probes, and unreferenced login/challenge checks are filtered out of the stored DRAFT. Page reads and screenshots are kept only when their step names correspond to user-requested checklist work. Failed or explicitly unverified clicks are never eligible.

This means a stuck teaching session can keep rich diagnostic evidence in the conversation/runtime without polluting the flow graph with steps that did not complete a checklist item.

## Login-state policy

Absence of a password field is not authentication evidence. `browser_login_state` reports `authenticated` only when positive application controls such as logout/workbench/dashboard indicators are visible. Portal shells, splash screens, and logo-only pages therefore remain `unknown` instead of being incorrectly treated as authenticated.
