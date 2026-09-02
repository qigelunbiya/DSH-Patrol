// Host-side anchor for the Patrol browser UI companion.
//
// This plugin intentionally registers no host services or Patrol tools. Its only
// purpose is to give the web profile Loader a stable package row whose nearest
// package.json declares dsh.client, allowing ClientModuleRegistry to publish the
// browser bundle in window.__DSH_BOOT__. Patrol orchestration itself remains
// scoped to the dedicated Agent Preset.
export const name = 'dsh-patrol-client-host'
export const inject = []

export function apply() {}
