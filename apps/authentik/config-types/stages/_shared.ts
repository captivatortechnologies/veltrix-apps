// Shared helpers for the authentik Stages config type (deploy + rollback +
// drift). Covers four genuinely distinct authentik models, each with its own
// endpoint and Request schema — see lib/authentikApi.ts for citations:
//   identification          IdentificationStage / IdentificationStageRequest        /stages/identification/
//   password                 PasswordStage / PasswordStageRequest                     /stages/password/
//   authenticator-validate    AuthenticatorValidateStage / ...Request                  /stages/authenticator/validate/
//   user-login                UserLoginStage / UserLoginStageRequest                   /stages/user_login/
//
// IDENTITY: the path key is a server-assigned UUID (`stage_uuid`) for every
// type — this config type upserts by NAME within the item's selected type's
// endpoint (list `?name=` → match → PATCH/POST).

export const STAGE_TYPES = new Set(['identification', 'password', 'authenticator-validate', 'user-login'])
export type StageType = 'identification' | 'password' | 'authenticator-validate' | 'user-login'

/** The `/stages/<segment>/` path segment for each type (note the nested authenticator/validate path). */
export const STAGE_ENDPOINT_SEGMENT: Record<StageType, string> = {
  identification: 'identification',
  password: 'password',
  'authenticator-validate': 'authenticator/validate',
  'user-login': 'user_login',
}

export const USER_FIELDS = new Set(['email', 'username', 'upn'])
export const BACKENDS = new Set([
  'authentik.core.auth.InbuiltBackend',
  'authentik.core.auth.TokenBackend',
  'authentik.sources.ldap.auth.LDAPBackend',
  'authentik.sources.kerberos.auth.KerberosBackend',
])
export const DEVICE_CLASSES = new Set(['static', 'totp', 'webauthn', 'duo', 'sms', 'email'])
export const NOT_CONFIGURED_ACTIONS = new Set(['skip', 'deny', 'configure'])

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthentikStage {
  pk?: string
  name?: string
  user_fields?: string[]
  case_insensitive_matching?: boolean
  show_matched_user?: boolean
  pretend_user_exists?: boolean
  enrollment_flow?: string | null
  recovery_flow?: string | null
  backends?: string[]
  failed_attempts_before_cancel?: number
  allow_show_password?: boolean
  device_classes?: string[]
  not_configured_action?: string
  last_auth_threshold?: string
  session_duration?: string
  terminate_other_sessions?: boolean
  remember_me_offset?: string
  [key: string]: unknown
}

export interface ManagedStageFields {
  name: string
  type: StageType
  // identification
  userFields: string[]
  caseInsensitiveMatching: boolean
  showMatchedUser: boolean
  pretendUserExists: boolean
  enrollmentFlow: string
  recoveryFlow: string
  // password
  backends: string[]
  failedAttemptsBeforeCancel: number | null
  allowShowPassword: boolean
  // authenticator-validate
  deviceClasses: string[]
  notConfiguredAction: string
  lastAuthThreshold: string
  // user-login
  sessionDuration: string
  terminateOtherSessions: boolean
  rememberMeOffset: string
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

export function readStringList(value: unknown): string[] {
  const raw: string[] = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[\r\n,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

export function readStageType(value: unknown): StageType {
  const t = String(value ?? '').trim()
  return STAGE_TYPES.has(t) ? (t as StageType) : 'identification'
}

export function readManagedFields(fields: Record<string, unknown>): ManagedStageFields {
  const notConfiguredAction = String(fields.not_configured_action ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    type: readStageType(fields.type),
    userFields: readStringList(fields.user_fields),
    caseInsensitiveMatching: normalizeBool(fields.case_insensitive_matching, true),
    showMatchedUser: normalizeBool(fields.show_matched_user, true),
    pretendUserExists: normalizeBool(fields.pretend_user_exists, false),
    enrollmentFlow: String(fields.enrollment_flow ?? '').trim(),
    recoveryFlow: String(fields.recovery_flow ?? '').trim(),
    backends: readStringList(fields.backends),
    failedAttemptsBeforeCancel: readOptionalInt(fields.failed_attempts_before_cancel),
    allowShowPassword: normalizeBool(fields.allow_show_password, false),
    deviceClasses: readStringList(fields.device_classes),
    notConfiguredAction: NOT_CONFIGURED_ACTIONS.has(notConfiguredAction) ? notConfiguredAction : 'configure',
    lastAuthThreshold: String(fields.last_auth_threshold ?? '').trim(),
    sessionDuration: String(fields.session_duration ?? '').trim(),
    terminateOtherSessions: normalizeBool(fields.terminate_other_sessions, false),
    rememberMeOffset: String(fields.remember_me_offset ?? '').trim(),
  }
}

/** Build the request body for the item's SELECTED type only. Optional fields are only sent when declared. */
function buildManagedBody(managed: ManagedStageFields): Record<string, unknown> {
  const body: Record<string, unknown> = { name: managed.name }
  if (managed.type === 'identification') {
    if (managed.userFields.length > 0) body.user_fields = managed.userFields
    body.case_insensitive_matching = managed.caseInsensitiveMatching
    body.show_matched_user = managed.showMatchedUser
    body.pretend_user_exists = managed.pretendUserExists
    if (managed.enrollmentFlow) body.enrollment_flow = managed.enrollmentFlow
    if (managed.recoveryFlow) body.recovery_flow = managed.recoveryFlow
    return body
  }
  if (managed.type === 'password') {
    body.backends = managed.backends
    if (managed.failedAttemptsBeforeCancel != null) body.failed_attempts_before_cancel = managed.failedAttemptsBeforeCancel
    body.allow_show_password = managed.allowShowPassword
    return body
  }
  if (managed.type === 'authenticator-validate') {
    if (managed.deviceClasses.length > 0) body.device_classes = managed.deviceClasses
    body.not_configured_action = managed.notConfiguredAction
    if (managed.lastAuthThreshold) body.last_auth_threshold = managed.lastAuthThreshold
    return body
  }
  // user-login
  if (managed.sessionDuration) body.session_duration = managed.sessionDuration
  body.terminate_other_sessions = managed.terminateOtherSessions
  if (managed.rememberMeOffset) body.remember_me_offset = managed.rememberMeOffset
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedStageFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

/** Snapshot a live stage into the SAME shape as `readManagedFields`, for the given type. */
export function snapshotManagedFields(stage: AuthentikStage, type: StageType): ManagedStageFields {
  const notConfiguredAction = String(stage.not_configured_action ?? '').trim()
  return {
    name: String(stage.name ?? '').trim(),
    type,
    userFields: Array.isArray(stage.user_fields) ? stage.user_fields.map(String) : [],
    caseInsensitiveMatching: normalizeBool(stage.case_insensitive_matching, true),
    showMatchedUser: normalizeBool(stage.show_matched_user, true),
    pretendUserExists: normalizeBool(stage.pretend_user_exists, false),
    enrollmentFlow: String(stage.enrollment_flow ?? '').trim(),
    recoveryFlow: String(stage.recovery_flow ?? '').trim(),
    backends: Array.isArray(stage.backends) ? stage.backends.map(String) : [],
    failedAttemptsBeforeCancel: typeof stage.failed_attempts_before_cancel === 'number' ? stage.failed_attempts_before_cancel : null,
    allowShowPassword: normalizeBool(stage.allow_show_password, false),
    deviceClasses: Array.isArray(stage.device_classes) ? stage.device_classes.map(String) : [],
    notConfiguredAction: NOT_CONFIGURED_ACTIONS.has(notConfiguredAction) ? notConfiguredAction : 'configure',
    lastAuthThreshold: String(stage.last_auth_threshold ?? '').trim(),
    sessionDuration: String(stage.session_duration ?? '').trim(),
    terminateOtherSessions: normalizeBool(stage.terminate_other_sessions, false),
    rememberMeOffset: String(stage.remember_me_offset ?? '').trim(),
  }
}

export function sameManagedFields(expected: ManagedStageFields, actual: ManagedStageFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.type === 'identification') {
    if (expected.userFields.length > 0 && !sameStringSet(expected.userFields, actual.userFields)) return false
    if (expected.caseInsensitiveMatching !== actual.caseInsensitiveMatching) return false
    if (expected.showMatchedUser !== actual.showMatchedUser) return false
    if (expected.pretendUserExists !== actual.pretendUserExists) return false
    if (expected.enrollmentFlow && expected.enrollmentFlow !== actual.enrollmentFlow) return false
    if (expected.recoveryFlow && expected.recoveryFlow !== actual.recoveryFlow) return false
    return true
  }
  if (expected.type === 'password') {
    if (!sameStringSet(expected.backends, actual.backends)) return false
    if (expected.failedAttemptsBeforeCancel != null && expected.failedAttemptsBeforeCancel !== actual.failedAttemptsBeforeCancel) return false
    if (expected.allowShowPassword !== actual.allowShowPassword) return false
    return true
  }
  if (expected.type === 'authenticator-validate') {
    if (expected.deviceClasses.length > 0 && !sameStringSet(expected.deviceClasses, actual.deviceClasses)) return false
    if (expected.notConfiguredAction !== actual.notConfiguredAction) return false
    if (expected.lastAuthThreshold && expected.lastAuthThreshold !== actual.lastAuthThreshold) return false
    return true
  }
  // user-login
  if (expected.sessionDuration && expected.sessionDuration !== actual.sessionDuration) return false
  if (expected.terminateOtherSessions !== actual.terminateOtherSessions) return false
  if (expected.rememberMeOffset && expected.rememberMeOffset !== actual.rememberMeOffset) return false
  return true
}
