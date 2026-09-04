export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export type InspectionSchemaVersion = '0.1' | '0.2'
export type InspectionStatus = 'draft' | 'ready'
export type AuthMode = 'none' | 'existing-session' | 'manual-checkpoint' | 'secret-ref'
export type ExpectationMode = 'contains' | 'not-contains'

export type ChallengeKind = 'otp' | 'captcha' | 'slider' | 'approval' | 'unknown'
export type ChallengeSubtype = 'otp' | 'image-code' | 'click-sequence' | 'third-party' | 'generic-captcha' | 'slider' | 'slider-puzzle' | 'rotate' | 'approval' | 'unknown'
export type ChallengeStrategy = 'windows-system-ocr' | 'ddddocr-click-sequence-demo' | 'ddddocr-slider-demo' | 'manual-click-sequence' | 'manual-slider' | 'manual-third-party' | 'manual-otp' | 'manual-approval' | 'manual-review'

export interface ChallengeProfile {
  kind: ChallengeKind
  subtype: ChallengeSubtype
  strategy: ChallengeStrategy
  firstObservedAt: string
  lastObservedAt: string
  occurrences: number
  autoCompletedOccurrences: number
}

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
  artifact?: StepArtifactKind | undefined
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
    /** Non-secret learned verification taxonomy. No cookie, OTP, captcha answer, or raw challenge image is stored here. */
    challengeProfiles?: ChallengeProfile[]
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
    /** Last interactive Harness workspace used by this inspection. Scheduled runs use it for user-visible outputs. */
    workspaceRoot?: string
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
  /** Harness session workspace where user-visible reports/artifacts were exported. */
  outputWorkspace?: string
}

export interface ResumeState {
  schemaVersion: '0.2'
  inspectionId: string
  runId: string
  startedAt: string
  definitionUpdatedAt: string
  nextStepIndex: number
  results: StepRunResult[]
  /** Why this run is resumable: a user checkpoint or a transient runtime blocker. */
  reason?: 'checkpoint' | 'recovery'
  /** Stable Runbook step that should be retried after transient recovery. */
  blockedStepId?: string
}

export interface SavedRunPaths {
  directory: string
  json: string
  markdown: string
}
