# Flow selection preview design

The blank Patrol conversation surface and the session header use the same two-stage flow launcher.

1. **Select**: opening the control lists available inspection flows. Clicking a flow only selects it and renders its metadata, task checklist, target, expected result, and ordered step graph.
2. **Execute**: replay starts only after the user presses **执行选中流程**. Selection itself must never send a replay prompt.

The chooser intentionally displays step names/tool names and non-secret flow metadata, but does not render raw step arguments. This keeps credential references and other implementation details out of the preview surface while still making it possible to verify that the selected flow is the intended one.
