export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export type InspectionSchemaVersion = '0.1' | '0.2'
export type InspectionStatus = 'draft' | 'ready'
export type AuthMode = 'none' | 'existing-session' | 'manual-checkpoint' | 'secret-ref'
export type ExpectationMode = 'contains' | 'not-contains'

export const INSPECTION_ARTIFACTS = ['markdown-report', 'json-report', 'screenshot', 'page-text', 'page-summary'] as const
export type InspectionArtifact = typeof INSPECTION_ARTIFACTS[number]

export interface TextExpectation {
  mode: ExpectationMode
  value: string
  caseSensitive: boolean
}

export interface StepCondition extends TextExpectation {
  sourceStepId: string
}

export interface SemanticLocator {
  text?: string
  role?: string
  tag?: string
}

export type StepArtifactKind = 'page-text' | 'screenshot'

export interface ToolStep {
  id: string
  kind: 'tool'
  name: string
  tool: string
  arguments: JsonObject
  expectation?: TextExpectation
  when?: StepCondition
  locator?: SemanticLocator
  artifact?: StepArtifactKind
  sensitive?: boolean
  notes?: string
  recordedAt: string
}

export interface CheckpointStep {
  id: string
  kind: 'checkpoint'
  name: string
  prompt: string
  reason: 'login' | 'otp' | 'approval' | 'other'
  when?: StepCondition
  notes?: string
  recordedAt: string
}

export type InspectionStep = ToolStep | CheckpointStep

export interface InspectionDefinition {
  schemaVersion: InspectionSchemaVersion
  id: string
  name: string
  description: string
  status: InspectionStatus
  target: {
    type: 'browser'
    url: string
  }
  expectedResult: string
  artifacts: InspectionArtifact[]
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

export type StepRunStatus = 'passed' | 'failed' | 'waiting' | 'skipped'

export interface RunArtifact {
  kind: StepArtifactKind
  path: string
}

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
  artifacts?: RunArtifact[]
  healedSelector?: string
}

export interface RunReport {
  schemaVersion: '0.2'
  runId: string
  inspectionId: string
  inspectionName: string
  startedAt: string
  finishedAt: string
  status: 'passed' | 'failed' | 'waiting'
  expectedResult: string
  results: StepRunResult[]
  summary?: string
}

export interface ResumeState {
  schemaVersion: '0.2'
  inspectionId: string
  runId: string
  startedAt: string
  definitionUpdatedAt: string
  nextStepIndex: number
  results: StepRunResult[]
}

export interface SavedRunPaths {
  directory: string
  json: string
  markdown: string
}
