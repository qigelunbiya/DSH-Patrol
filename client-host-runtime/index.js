// Host-side anchor for the Patrol browser UI companion.
//
// Keep this row independent from the process-global browser bridge host. The
// web profile loads this nested package only so ClientModuleRegistry sees one
// stable dsh.client package row and publishes client-host-runtime/client.js in
// window.__DSH_BOOT__. Patrol orchestration/tools remain scoped to the Patrol
// Agent Preset, while the browser bridge continues to use its own host row.
export const name = 'dsh-patrol-client-host'
export const inject = []

export function apply() {}
