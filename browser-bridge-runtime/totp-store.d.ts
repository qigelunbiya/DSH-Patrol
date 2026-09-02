export interface TotpPublicProfile {
  id: string
  issuer: string
  account: string
  label: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  createdAt: string
  updatedAt: string
}

export interface GeneratedTotp {
  code: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  counter: number
  validForSeconds: number
}

export interface GeneratedProfileTotp extends GeneratedTotp {
  profile: TotpPublicProfile
}

export function parseTotpUri(value: string): {
  secret: string
  issuer: string
  account: string
  label: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
}

export function saveTotpProfileFromUri(profileId: string, uri: string): TotpPublicProfile
export function saveTotpProfilesFromPayload(profileId: string, payload: string): TotpPublicProfile[]
export function listTotpProfiles(): TotpPublicProfile[]
export function describeTotpProfile(profileId: string): TotpPublicProfile | undefined
export function deleteTotpProfile(profileId: string): boolean
export function generateTotpForProfile(profileId: string, timestampMs?: number): GeneratedProfileTotp
export function generateTotp(config: {
  secret: string
  algorithm?: string
  digits?: number
  period?: number
}, timestampMs?: number): GeneratedTotp
export function totpProfileStorePath(): string
