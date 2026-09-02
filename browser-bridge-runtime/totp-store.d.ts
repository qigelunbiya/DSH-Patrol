export interface TotpPublicProfile {
  id: string
  issuer: string
  account: string
  label: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  createdAt?: string
  updatedAt?: string
}

export interface ParsedTotpProfile extends Omit<TotpPublicProfile, 'id' | 'createdAt' | 'updatedAt'> {
  secret: string
}

export interface GeneratedTotp {
  code: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  counter: number
  validForSeconds: number
}

export function parseTotpUri(value: unknown): ParsedTotpProfile
export function parseTotpImportPayload(value: unknown): ParsedTotpProfile[]
export function saveTotpProfilesFromPayload(profileIdHint: unknown, payload: unknown): TotpPublicProfile[]
export function saveTotpProfileFromUri(profileId: unknown, uri: unknown): TotpPublicProfile | undefined
export function listTotpProfiles(): TotpPublicProfile[]
export function describeTotpProfile(profileId: string): TotpPublicProfile | undefined
export function deleteTotpProfile(profileId: string): boolean
export function generateTotpForProfile(profileId: string, timestampMs?: number): GeneratedTotp & { profile: TotpPublicProfile }
export function generateTotp(config: { secret: unknown; algorithm?: unknown; digits?: unknown; period?: unknown }, timestampMs?: number): GeneratedTotp
export function totpProfileStorePath(): string
