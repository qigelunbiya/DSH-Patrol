import type { InspectionDefinition, JsonObject, JsonValue } from './types.ts'

const INSPECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function assertInspectionId(id: string): void {
  if (!INSPECTION_ID.test(id)) {
    throw new Error('inspectionId must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/')
  }
}

export function asJsonObject(value: JsonValue): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('tool arguments must be a JSON object')
  }
  return value
}

export function assertInspectionDefinition(value: unknown): asserts value is InspectionDefinition {
  if (value === null || typeof value !== 'object') throw new Error('inspection.json must contain an object')
  const candidate = value as Partial<InspectionDefinition>
  if (candidate.schemaVersion !== '0.1') throw new Error('unsupported inspection schemaVersion')
  if (typeof candidate.id !== 'string') throw new Error('inspection.id must be a string')
  assertInspectionId(candidate.id)
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) throw new Error('inspection.name is required')
  if (candidate.status !== 'draft' && candidate.status !== 'ready') throw new Error('inspection.status is invalid')
  if (!Array.isArray(candidate.steps)) throw new Error('inspection.steps must be an array')

  const target = candidate.target as unknown
  if (target === null || typeof target !== 'object') {
    throw new Error('inspection.target must be a browser target with url')
  }
  const targetRecord = target as Record<string, unknown>
  if (targetRecord.type !== 'browser' || typeof targetRecord.url !== 'string' || targetRecord.url.length === 0) {
    throw new Error('inspection.target must be a browser target with url')
  }
}
