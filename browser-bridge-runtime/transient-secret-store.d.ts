export function rememberTransientSecret(value: string): string
export function resolveTransientSecret(ref: string): string | undefined
export function forgetTransientSecret(ref: string): void
export function clearTransientSecrets(): void
