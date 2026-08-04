// Shared helpers for the Password Safe Managed Accounts config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// SECRET MATERIAL DROPPED (PAM app posture): Password Safe accepts a manually
// supplied Password / PrivateKey / Passphrase on create when AutoManagementFlag
// is false. This app NEVER authors that secret material as code — an operator
// would have to paste a live credential into a canvas field, which this app's
// PAM posture (see README) treats as out of scope, same as functional-accounts'
// optional password field being deliberately narrow. This config type therefore
// ONLY supports AUTO-MANAGED accounts: AutoManagementFlag is always sent `true`
// and Password Safe itself generates and subsequently rotates the secret.
// Manual/static-password managed accounts are out of scope.
//
// A managed account's parent is an EXISTING managed system, referenced by its
// SystemName (resolved to a ManagedSystemID at deploy time) — mirrors the
// native API's own GET /ManagedAccounts?systemName=&accountName= lookup shape.
//
// PUT /ManagedAccounts/{id} and DELETE /ManagedAccounts/{id} ARE documented, so
// unlike functional-accounts/user-groups/workgroups this config type is a REAL
// upsert (create OR update), and rollback can restore the prior field values
// for an account it updated (not just delete one it created) — same shape as
// e.g. the Keycloak app's protocol-mappers config type.
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET    /ManagedSystems                            resolve the parent system by name
//   GET    /ManagedSystems/{systemID}/ManagedAccounts  list accounts on that system
//   POST   /ManagedSystems/{systemID}/ManagedAccounts  create (identity: accountName + domainName)
//   PUT    /ManagedAccounts/{id}                       update
//   DELETE /ManagedAccounts/{id}                       delete

/** Change-frequency schedule Password Safe accepts for an auto-managed account. */
export const CHANGE_FREQUENCY_TYPES = new Set(['', 'first', 'last', 'xdays'])

/** One managed system as returned by GET /ManagedSystems (only the fields this type needs). */
export interface ManagedSystemRef {
  ManagedSystemID?: number | string
  SystemName?: string
  [key: string]: unknown
}

/** One managed account as returned by GET /ManagedSystems/{id}/ManagedAccounts. */
export interface ManagedAccount {
  ManagedAccountID?: number | string
  AccountName?: string
  DomainName?: string | null
  Description?: string | null
  PasswordRuleID?: number | null
  ReleaseDuration?: number | null
  MaxReleaseDuration?: number | null
  ISAReleaseDuration?: number | null
  AutoManagementFlag?: boolean
  CheckPasswordFlag?: boolean
  ChangeFrequencyType?: string | null
  ChangeFrequencyDays?: number | null
  ChangeTime?: string | null
  [key: string]: unknown
}

/** The create/update body sent to /ManagedSystems/{id}/ManagedAccounts (POST) or /ManagedAccounts/{id} (PUT). */
export interface ManagedAccountBody {
  AccountName: string
  DomainName?: string
  Description?: string
  AutoManagementFlag: true
  PasswordRuleID?: number
  ReleaseDuration?: number
  MaxReleaseDuration?: number
  ISAReleaseDuration?: number
  CheckPasswordFlag?: boolean
  ChangeFrequencyType?: string
  ChangeFrequencyDays?: number
  ChangeTime?: string
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

/** Find a live managed system by its (case-insensitive) SystemName. */
export function findManagedSystemByName(systems: ManagedSystemRef[], systemName: string): ManagedSystemRef | null {
  const wanted = systemName.trim().toLowerCase()
  return systems.find((s) => str(s.SystemName).toLowerCase() === wanted) ?? null
}

/** A managed account's identity, within one system, is (account name, domain). */
export function accountIdentity(accountName: unknown, domainName: unknown): string {
  return `${str(accountName).toLowerCase()} ${str(domainName).toLowerCase()}`
}

/** Find a live managed account by its (account name, domain) identity. */
export function findManagedAccount(accounts: ManagedAccount[], accountName: unknown, domainName: unknown): ManagedAccount | null {
  const wanted = accountIdentity(accountName, domainName)
  return accounts.find((a) => accountIdentity(a.AccountName, a.DomainName) === wanted) ?? null
}

/** Build the create/update body from canvas fields. Always auto-managed — see header. */
export function buildAccountBody(fields: Record<string, unknown>): ManagedAccountBody {
  const body: ManagedAccountBody = {
    AccountName: str(fields.accountName),
    AutoManagementFlag: true,
  }
  const domainName = str(fields.domainName)
  if (domainName) body.DomainName = domainName
  const description = str(fields.description)
  if (description) body.Description = description
  const passwordRuleId = toPositiveInt(fields.passwordRuleId)
  if (passwordRuleId !== null) body.PasswordRuleID = passwordRuleId
  const releaseDuration = toNonNegativeInt(fields.releaseDuration)
  if (releaseDuration !== null) body.ReleaseDuration = releaseDuration
  const maxReleaseDuration = toNonNegativeInt(fields.maxReleaseDuration)
  if (maxReleaseDuration !== null) body.MaxReleaseDuration = maxReleaseDuration
  const isaReleaseDuration = toNonNegativeInt(fields.isaReleaseDuration)
  if (isaReleaseDuration !== null) body.ISAReleaseDuration = isaReleaseDuration
  body.CheckPasswordFlag = toBool(fields.checkPasswordFlag, false)
  const changeFrequencyType = str(fields.changeFrequencyType)
  if (changeFrequencyType) body.ChangeFrequencyType = changeFrequencyType
  const changeFrequencyDays = toNonNegativeInt(fields.changeFrequencyDays)
  if (changeFrequencyDays !== null) body.ChangeFrequencyDays = changeFrequencyDays
  const changeTime = str(fields.changeTime)
  if (changeTime) body.ChangeTime = changeTime
  return body
}

/** Project the fields this config type manages off a live account, for drift comparison. */
export interface AccountProjection {
  description: string
  passwordRuleId: number | null
  releaseDuration: number | null
  maxReleaseDuration: number | null
  isaReleaseDuration: number | null
  checkPasswordFlag: boolean
}

export function projectFromFields(fields: Record<string, unknown>): AccountProjection {
  return {
    description: str(fields.description),
    passwordRuleId: toPositiveInt(fields.passwordRuleId),
    releaseDuration: toNonNegativeInt(fields.releaseDuration),
    maxReleaseDuration: toNonNegativeInt(fields.maxReleaseDuration),
    isaReleaseDuration: toNonNegativeInt(fields.isaReleaseDuration),
    checkPasswordFlag: toBool(fields.checkPasswordFlag, false),
  }
}

export function projectFromLive(account: ManagedAccount): AccountProjection {
  return {
    description: str(account.Description),
    passwordRuleId: typeof account.PasswordRuleID === 'number' ? account.PasswordRuleID : null,
    releaseDuration: typeof account.ReleaseDuration === 'number' ? account.ReleaseDuration : null,
    maxReleaseDuration: typeof account.MaxReleaseDuration === 'number' ? account.MaxReleaseDuration : null,
    isaReleaseDuration: typeof account.ISAReleaseDuration === 'number' ? account.ISAReleaseDuration : null,
    checkPasswordFlag: Boolean(account.CheckPasswordFlag),
  }
}
