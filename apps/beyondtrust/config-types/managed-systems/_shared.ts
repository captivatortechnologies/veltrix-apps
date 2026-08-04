// Shared helpers for the Password Safe Managed Systems config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// RE-EVALUATED from the v0.2.0 "considered and dropped" note: Managed Systems
// creation (POST /Assets/{assetId}/ManagedSystems or
// POST /Databases/{databaseId}/ManagedSystems) needs an existing, DISCOVERED
// Asset or Database — a parent this app cannot author. But Password Safe ALSO
// exposes POST /Workgroups/{workgroupId}/ManagedSystems, which creates a managed
// system directly under a Workgroup — no Asset/Database required. Because this
// app already owns Workgroup creation (config-types/workgroups), that parent is
// no longer un-authorable: a managed system here is scoped to a Workgroup this
// app created (or an existing one), referenced by NAME and resolved to its id at
// deploy time (same "resolve parent by name" shape used by e.g. the Keycloak
// app's protocol-mappers config type).
//
// FLAGGED (platform-conditional): Password Safe's ManagedSystem shape carries
// several fields whose requiredness depends on the target Platform (e.g.
// AccountNameFormat is Active Directory-only; certain cloud/database platforms
// need fields this app does not model). This config type declares the
// UNIVERSAL, platform-independent fields plus the common optional ones
// documented across the public API; a platform with additional required fields
// should be verified against a live instance before use — same posture
// functional-accounts already takes for its own platform-conditional fields.
//
// FLAGGED (no confirmed update/delete): PUT /ManagedSystems/{id} and
// DELETE /ManagedSystems/{id} are not confirmed as documented endpoints (only a
// DELETE for the system's CHILD managed accounts was found). Deploy is
// therefore create-if-absent, and rollback cannot remove a created system —
// same conservative posture as workgroups, and doubly appropriate here since a
// wrongly-guessed delete could cascade into live managed accounts and secrets.
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET  /Workgroups                          resolve the parent workgroup by name
//   GET  /ManagedSystems                       list all managed systems
//   POST /Workgroups/{workgroupID}/ManagedSystems   create, scoped to that workgroup

/** AD-only account name formats (GET/POST ManagedSystems, AccountNameFormat). */
export const ACCOUNT_NAME_FORMATS = new Set([0, 1, 2])

/** One workgroup as returned by GET /Workgroups (duplicated locally — config
 * types never import from a sibling config-type folder). */
export interface WorkgroupRef {
  WorkgroupID?: number | string
  ID?: number | string
  Name?: string
  [key: string]: unknown
}

/** One managed system as returned by GET /ManagedSystems. */
export interface ManagedSystem {
  ManagedSystemID?: number | string
  WorkgroupID?: number | string
  AssetID?: number | string | null
  DatabaseID?: number | string | null
  PlatformID?: number | string
  SystemName?: string
  ContactEmail?: string | null
  Description?: string | null
  Timeout?: number | null
  Port?: number | null
  AccountNameFormat?: number | null
  PasswordRuleID?: number | null
  DSSKeyRuleID?: number | null
  ReleaseDuration?: number | null
  MaxReleaseDuration?: number | null
  ISAReleaseDuration?: number | null
  AutoManagementFlag?: boolean
  CheckPasswordFlag?: boolean
  ChangePasswordAfterAnyReleaseFlag?: boolean
  ResetPasswordOnMismatchFlag?: boolean
  FunctionalAccountID?: number | string | null
  [key: string]: unknown
}

/** The create body POSTed to /Workgroups/{workgroupID}/ManagedSystems. */
export interface ManagedSystemCreate {
  PlatformID: number
  SystemName: string
  ContactEmail?: string
  Description?: string
  Timeout?: number
  Port?: number
  AccountNameFormat?: number
  PasswordRuleID?: number
  DSSKeyRuleID?: number
  ReleaseDuration?: number
  MaxReleaseDuration?: number
  ISAReleaseDuration?: number
  AutoManagementFlag?: boolean
  CheckPasswordFlag?: boolean
  ChangePasswordAfterAnyReleaseFlag?: boolean
  ResetPasswordOnMismatchFlag?: boolean
  FunctionalAccountID?: number
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas number/string to a positive integer, or null when not one. */
export function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Coerce a canvas number/string to a non-negative integer, or null when blank/invalid. */
export function toNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Coerce a canvas checkbox/string to a boolean, defaulting to `fallback` when blank. */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function listFrom<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: T[] }).Data
  }
  return []
}

/** Find a live workgroup by its (case-insensitive) name. */
export function findWorkgroupByName(workgroups: WorkgroupRef[], name: string): WorkgroupRef | null {
  const wanted = name.trim().toLowerCase()
  return workgroups.find((w) => str(w.Name).toLowerCase() === wanted) ?? null
}

/** The workgroup id, across response shapes. */
export function workgroupIdOf(workgroup: WorkgroupRef): number | string | null {
  return workgroup.WorkgroupID ?? workgroup.ID ?? null
}

/** A managed system's identity is (workgroup, system name) — the same system
 * name could exist under a different workgroup. Case-folded on the name. */
export function systemIdentity(workgroupId: number | string, systemName: unknown): string {
  return `${workgroupId} ${str(systemName).toLowerCase()}`
}

/** Find a live managed system by its (workgroup, system name) identity. */
export function findManagedSystem(
  systems: ManagedSystem[],
  workgroupId: number | string,
  systemName: unknown,
): ManagedSystem | null {
  const wanted = systemIdentity(workgroupId, systemName)
  return systems.find((s) => s.WorkgroupID != null && systemIdentity(s.WorkgroupID, s.SystemName) === wanted) ?? null
}

/** Build the /Workgroups/{id}/ManagedSystems create body from canvas fields. */
export function buildCreateBody(fields: Record<string, unknown>): ManagedSystemCreate {
  const body: ManagedSystemCreate = {
    PlatformID: toPositiveInt(fields.platformId) ?? 0,
    SystemName: str(fields.systemName),
  }
  const contactEmail = str(fields.contactEmail)
  if (contactEmail) body.ContactEmail = contactEmail
  const description = str(fields.description)
  if (description) body.Description = description
  const timeout = toNonNegativeInt(fields.timeout)
  if (timeout !== null) body.Timeout = timeout
  const port = toNonNegativeInt(fields.port)
  if (port !== null) body.Port = port
  const accountNameFormat = toNonNegativeInt(fields.accountNameFormat)
  if (accountNameFormat !== null && ACCOUNT_NAME_FORMATS.has(accountNameFormat)) body.AccountNameFormat = accountNameFormat
  const passwordRuleId = toPositiveInt(fields.passwordRuleId)
  if (passwordRuleId !== null) body.PasswordRuleID = passwordRuleId
  const dssKeyRuleId = toPositiveInt(fields.dssKeyRuleId)
  if (dssKeyRuleId !== null) body.DSSKeyRuleID = dssKeyRuleId
  const releaseDuration = toNonNegativeInt(fields.releaseDuration)
  if (releaseDuration !== null) body.ReleaseDuration = releaseDuration
  const maxReleaseDuration = toNonNegativeInt(fields.maxReleaseDuration)
  if (maxReleaseDuration !== null) body.MaxReleaseDuration = maxReleaseDuration
  const isaReleaseDuration = toNonNegativeInt(fields.isaReleaseDuration)
  if (isaReleaseDuration !== null) body.ISAReleaseDuration = isaReleaseDuration
  body.AutoManagementFlag = toBool(fields.autoManagementFlag, true)
  body.CheckPasswordFlag = toBool(fields.checkPasswordFlag, false)
  body.ChangePasswordAfterAnyReleaseFlag = toBool(fields.changePasswordAfterAnyReleaseFlag, false)
  body.ResetPasswordOnMismatchFlag = toBool(fields.resetPasswordOnMismatchFlag, false)
  const functionalAccountId = toPositiveInt(fields.functionalAccountId)
  if (functionalAccountId !== null) body.FunctionalAccountID = functionalAccountId
  return body
}
