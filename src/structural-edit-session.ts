const activeStructuralEdits = new Set<string>()

const APPEND_STYLE_PATROL_TOOLS = new Set([
  'patrol_navigate',
  'patrol_click',
  'patrol_click_target',
  'patrol_visual_click_target',
  'patrol_press',
  'patrol_scroll',
  'patrol_wait',
  'patrol_screenshot',
  'patrol_snapshot',
  'patrol_read_page',
  'patrol_count',
  'patrol_login_state',
  'patrol_type_text',
  'patrol_type_focused_text',
  'patrol_type_transient',
  'patrol_type_credential',
  'patrol_type_current_image_code',
  'patrol_solve_current_image_code',
  'patrol_desktop_action',
])

export function enterStructuralEditSession(inspectionId: string): void {
  const id = inspectionId.trim()
  if (id) activeStructuralEdits.add(id)
}

export function leaveStructuralEditSession(inspectionId: string): void {
  activeStructuralEdits.delete(inspectionId.trim())
}

export function isStructuralEditSession(inspectionId: string): boolean {
  return activeStructuralEdits.has(inspectionId.trim())
}

export function clearStructuralEditSessionsForTest(): void {
  activeStructuralEdits.clear()
}

export function structuralEditAppendGuard(execution: any): string | undefined {
  const name = String(execution?.name ?? '')
  const args = isRecord(execution?.arguments) ? execution.arguments : {}
  const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''
  if (!inspectionId || !isStructuralEditSession(inspectionId)) return undefined

  if (name === 'patrol_delete' || name === 'patrol_delete_flow') {
    leaveStructuralEditSession(inspectionId)
    return undefined
  }

  if (!APPEND_STYLE_PATROL_TOOLS.has(name)) return undefined

  return [
    `Runbook structural edit isolation is active for ${inspectionId}; ${name} was NOT executed.`,
    'The user is editing an existing flow, so execution-and-record teaching tools must not append a new tail round.',
    'Use patrol_insert_* with beforeStepId/afterStepId or taskChecklistItem for a genuinely missing step;',
    'use patrol_update_*/patrol_move_step/patrol_remove_steps for structural changes;',
    'use patrol_reteach_* only when the existing step itself must be relearned.',
    'patrol_observe, patrol_show, patrol_task_checklist, patrol_run_flow and patrol_validate may be used for read-only evidence/verification without appending teaching steps.',
  ].join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
