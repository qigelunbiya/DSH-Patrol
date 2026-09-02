// Host-plane carrier for both the Patrol browser bridge and Patrol web UI.
//
// The Loader entry points at this nested package so ClientModuleRegistry sees a
// single dedicated dsh.client package row. The actual host bridge implementation
// remains in browser-bridge-runtime; Patrol orchestration/tools remain scoped to
// the dedicated Agent Preset and are not registered globally by this carrier.
export { name, inject, apply } from '../browser-bridge-runtime/index.js'
