export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export type InspectionStatus = 'draft' | 'ready'
export type AuthMode = 'none' | 'existing-session' | 'manual-checkpoint' | 'secret-ref'
export type ExpectationMode = 'contains' | 'not-contains'

export interface TextExpectation {
  mode: ExpectationMode
  value: string
  caseSensitive: boolean
}

export interface ToolStep {
  id: string
  kind: 'tool'
  name: string
  tool: string
  arguments: JsonObject
  expectation?: TextExpectation
  notes?: string
  recordedAt: string
}

export interface CheckpointStep {
  id: string
  kind: 'checkpoint'
  name: string
  prompt: string
  reason: 'login' | 'otp' | 'approval' | 'other'
  notes?: string
  recordedAt: string
}

export type InspectionStep = ToolStep | CheckpointStep

export interface InspectionDefinition {
  schemaVersion: '0.1'
  id: string
  name: string
  description: string
  status: InspectionStatus
  target: {
    type: 'browser'
    url: string
  }
  expectedResult: string
  artifacts: string[]
  auth: {
    mode: AuthMode
    notes?: string
  }
  schedule: null | {
    enabled: boolean
    cron?: string
  }
  steps: InspectionStep[]
  metadata: {
    createdAt: string
    updatedAt: string
    validatedAt?: string
  }
}

export type StepRunStatus = 'passed' | 'failed' | 'waiting'

export interface StepRunResult {
  stepId: string
  name: string
  kind: InspectionStep['kind']
  status: StepRunStatus
  startedAt: string
  finishedAt: string
  tool?: string
  output?: string
  error?: string
}

export interface RunReport {
  schemaVersion: '0.1'
  runId: string
  inspectionId: string
  inspectionName: string
  startedAt: string
  finishedAt: string
  status: 'passed' | 'failed' | 'waiting'
  startedAtStepId?: string
  expectedResult: string
  results: StepRunResult[]
}

export interface SavedRunPaths {
  directory: string
  json: string
  markdown: string
}
