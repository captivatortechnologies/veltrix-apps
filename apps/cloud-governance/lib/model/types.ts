// =============================================================================
// Internal policy model — the ONLY shape the UI, store and compiler exchange.
//
// It is a strict subset of a Cloud Custodian (c7n) policy plus the Veltrix
// fields the safety ladder needs. Tenant YAML is never accepted raw: the
// admission compiler (lib/compiler) turns this model into c7n YAML and refuses
// anything outside the allow-lists. Keep this file dependency-free.
// =============================================================================

export type Provider = 'aws' | 'azure'

export const PROVIDERS: readonly Provider[] = ['aws', 'azure']

export function isProvider(value: unknown): value is Provider {
  return value === 'aws' || value === 'azure'
}

/**
 * How far a run may go. `observe` and `notify` compile with actions stripped
 * (a match preview); `ask` keeps actions but each run's action set needs an
 * approval; `auto` runs approved actions under the resource cap.
 */
export type Enforcement = 'observe' | 'notify' | 'ask' | 'auto'

/** Reversibility of the policy's most dangerous action. Drives approval rules. */
export type ActionClass = 'none' | 'reversible' | 'snapshot-delete' | 'irreversible'

/** A c7n filter object, e.g. `{ type: 'value', key: 'State.Name', value: 'stopped' }`. */
export interface FilterObject {
  type: string
  [key: string]: unknown
}

/** c7n boolean combinators. Nested specs are compiled recursively. */
export interface FilterGroup {
  or?: FilterSpec[]
  and?: FilterSpec[]
  not?: FilterSpec[]
}

/** A string is c7n shorthand such as `"tag:Owner": absent` written as `tag:Owner`. */
export type FilterSpec = string | FilterObject | FilterGroup

export interface ActionObject {
  type: string
  [key: string]: unknown
}

export type ActionSpec = string | ActionObject

export interface GovernancePolicy {
  /** c7n policy name: lowercase, digits and hyphens, 1–64 chars. Unique per tenant. */
  name: string
  description?: string
  provider: Provider
  /** c7n resource type without provider prefix, e.g. `ec2`, `ebs`, `s3` (AWS) or `vm`, `storage` (Azure). */
  resource: string
  filters: FilterSpec[]
  actions: ActionSpec[]
  enforcement: Enforcement
  /** Absolute cap on resources a single run may act on. Compiler default: 100. */
  maxResources?: number
  /** Percentage cap relative to the resource population. Compiler default: 10. */
  maxResourcesPercent?: number
  /** Tag keys consulted (in order) to resolve a resource owner. */
  ownerTagKeys?: string[]
  /** Days between marking a resource and acting on it (mark-for-op). */
  gracePeriodDays?: number
  tags?: Record<string, string>
}

export interface PolicyPack {
  name: string
  description?: string
  /** Names of policies in this pack, applied together to the same accounts. */
  policies: string[]
}

export interface PolicyException {
  policy: string
  /** Resource id or ARN the exception covers. */
  resourceId: string
  reason: string
  approver: string
  /** ISO date; the compiler emits a `not` filter until then. */
  expiresAt: string
}

export interface PolicySchedule {
  policy: string
  /** Five-field cron, UTC. */
  cron: string
  enabled: boolean
  /** Enforcement for scheduled runs; never stronger than the policy's own. */
  enforcement: Enforcement
}

/** Shape of the c7n YAML document the compiler emits. */
export interface CompiledPolicyDocument {
  policies: Array<Record<string, unknown>>
}

export interface CompileIssue {
  /** Dotted path into the model, e.g. `filters.2.value_from`. */
  path: string
  code: string
  message: string
}

/** Non-union result: both `document` and `issues` are always present (platform handler loader gotcha). */
export interface CompileResult {
  ok: boolean
  document: CompiledPolicyDocument | null
  yaml: string | null
  errors: CompileIssue[]
  warnings: CompileIssue[]
  actionClass: ActionClass
  /** c7n action/filter types that need IAM; resolved to exact IAM actions by the runner. */
  usedTypes: { filters: string[]; actions: string[] }
}
