// Shared helpers for the authentik Policies config type (deploy + rollback +
// drift). Covers three genuinely distinct authentik models, each with its own
// endpoint and Request schema — see lib/authentikApi.ts for citations:
//   expression  ExpressionPolicy / ExpressionPolicyRequest   /policies/expression/
//   password    PasswordPolicy / PasswordPolicyRequest       /policies/password/
//   reputation  ReputationPolicy / ReputationPolicyRequest   /policies/reputation/
//
// IDENTITY: the path key is a server-assigned UUID (`policy_uuid`) for every
// type — this config type upserts by NAME within the item's selected type's
// endpoint (list `?name=` → match → PATCH/POST).

export const POLICY_TYPES = new Set(['expression', 'password', 'reputation'])
export type PolicyType = 'expression' | 'password' | 'reputation'

/** The `/policies/<segment>/` path segment for each type. */
export const POLICY_ENDPOINT_SEGMENT: Record<PolicyType, string> = {
  expression: 'expression',
  password: 'password',
  reputation: 'reputation',
}

export interface AuthentikPolicy {
  pk?: string
  policy_uuid?: string
  name?: string
  execution_logging?: boolean
  expression?: string
  password_field?: string
  length_min?: number
  amount_uppercase?: number
  amount_lowercase?: number
  amount_digits?: number
  amount_symbols?: number
  check_have_i_been_pwned?: boolean
  check_zxcvbn?: boolean
  check_ip?: boolean
  check_username?: boolean
  threshold?: number
  [key: string]: unknown
}

export interface ManagedPolicyFields {
  name: string
  type: PolicyType
  executionLogging: boolean
  // expression
  expression: string
  // password
  passwordField: string
  lengthMin: number | null
  amountUppercase: number | null
  amountLowercase: number | null
  amountDigits: number | null
  amountSymbols: number | null
  checkHaveIBeenPwned: boolean
  checkZxcvbn: boolean
  // reputation
  checkIp: boolean
  checkUsername: boolean
  threshold: number | null
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

export function readOptionalInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export function readPolicyType(value: unknown): PolicyType {
  const t = String(value ?? '').trim()
  return POLICY_TYPES.has(t) ? (t as PolicyType) : 'expression'
}

export function readManagedFields(fields: Record<string, unknown>): ManagedPolicyFields {
  return {
    name: String(fields.name ?? '').trim(),
    type: readPolicyType(fields.type),
    executionLogging: normalizeBool(fields.execution_logging, false),
    expression: String(fields.expression ?? ''),
    passwordField: String(fields.password_field ?? '').trim(),
    lengthMin: readOptionalInt(fields.length_min),
    amountUppercase: readOptionalInt(fields.amount_uppercase),
    amountLowercase: readOptionalInt(fields.amount_lowercase),
    amountDigits: readOptionalInt(fields.amount_digits),
    amountSymbols: readOptionalInt(fields.amount_symbols),
    checkHaveIBeenPwned: normalizeBool(fields.check_have_i_been_pwned, false),
    checkZxcvbn: normalizeBool(fields.check_zxcvbn, false),
    checkIp: normalizeBool(fields.check_ip, true),
    checkUsername: normalizeBool(fields.check_username, true),
    threshold: readOptionalInt(fields.threshold),
  }
}

/**
 * Build the request body for the item's SELECTED type only — the other
 * groups' fields are never sent (they belong to a different authentik model).
 * Optional numeric/string fields are only included when declared, so a PATCH
 * leaves authentik's own defaults for the rest untouched.
 */
function buildManagedBody(managed: ManagedPolicyFields): Record<string, unknown> {
  const common = { name: managed.name, execution_logging: managed.executionLogging }
  if (managed.type === 'expression') {
    return { ...common, expression: managed.expression }
  }
  if (managed.type === 'password') {
    const body: Record<string, unknown> = { ...common }
    if (managed.passwordField) body.password_field = managed.passwordField
    if (managed.lengthMin != null) body.length_min = managed.lengthMin
    if (managed.amountUppercase != null) body.amount_uppercase = managed.amountUppercase
    if (managed.amountLowercase != null) body.amount_lowercase = managed.amountLowercase
    if (managed.amountDigits != null) body.amount_digits = managed.amountDigits
    if (managed.amountSymbols != null) body.amount_symbols = managed.amountSymbols
    body.check_have_i_been_pwned = managed.checkHaveIBeenPwned
    body.check_zxcvbn = managed.checkZxcvbn
    return body
  }
  // reputation
  const body: Record<string, unknown> = { ...common, check_ip: managed.checkIp, check_username: managed.checkUsername }
  if (managed.threshold != null) body.threshold = managed.threshold
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedPolicyFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

/** Snapshot a live policy into the SAME shape as `readManagedFields`, for the given type. */
export function snapshotManagedFields(policy: AuthentikPolicy, type: PolicyType): ManagedPolicyFields {
  return {
    name: String(policy.name ?? '').trim(),
    type,
    executionLogging: normalizeBool(policy.execution_logging, false),
    expression: String(policy.expression ?? ''),
    passwordField: String(policy.password_field ?? '').trim(),
    lengthMin: typeof policy.length_min === 'number' ? policy.length_min : null,
    amountUppercase: typeof policy.amount_uppercase === 'number' ? policy.amount_uppercase : null,
    amountLowercase: typeof policy.amount_lowercase === 'number' ? policy.amount_lowercase : null,
    amountDigits: typeof policy.amount_digits === 'number' ? policy.amount_digits : null,
    amountSymbols: typeof policy.amount_symbols === 'number' ? policy.amount_symbols : null,
    checkHaveIBeenPwned: normalizeBool(policy.check_have_i_been_pwned, false),
    checkZxcvbn: normalizeBool(policy.check_zxcvbn, false),
    checkIp: normalizeBool(policy.check_ip, true),
    checkUsername: normalizeBool(policy.check_username, true),
    threshold: typeof policy.threshold === 'number' ? policy.threshold : null,
  }
}

export function sameManagedFields(expected: ManagedPolicyFields, actual: ManagedPolicyFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.executionLogging !== actual.executionLogging) return false
  if (expected.type === 'expression') {
    return expected.expression === actual.expression
  }
  if (expected.type === 'password') {
    if (expected.passwordField && expected.passwordField !== actual.passwordField) return false
    if (expected.lengthMin != null && expected.lengthMin !== actual.lengthMin) return false
    if (expected.amountUppercase != null && expected.amountUppercase !== actual.amountUppercase) return false
    if (expected.amountLowercase != null && expected.amountLowercase !== actual.amountLowercase) return false
    if (expected.amountDigits != null && expected.amountDigits !== actual.amountDigits) return false
    if (expected.amountSymbols != null && expected.amountSymbols !== actual.amountSymbols) return false
    if (expected.checkHaveIBeenPwned !== actual.checkHaveIBeenPwned) return false
    if (expected.checkZxcvbn !== actual.checkZxcvbn) return false
    return true
  }
  // reputation
  if (expected.checkIp !== actual.checkIp) return false
  if (expected.checkUsername !== actual.checkUsername) return false
  if (expected.threshold != null && expected.threshold !== actual.threshold) return false
  return true
}
