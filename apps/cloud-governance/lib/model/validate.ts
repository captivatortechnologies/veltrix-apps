import type {
  CompileIssue,
  Enforcement,
  FilterSpec,
  ActionSpec,
  GovernancePolicy,
  PolicyException,
  PolicyPack,
  PolicySchedule,
} from './types'
import { isAllowedResource, normalizeResource } from './awsResources'
import { isRecord, issue } from './issues'
import type { UnknownRecord } from './issues'
import { DENY_CODES, scanPolicyKeys } from '../compiler/denyList'

export interface Validated<T> {
  value: T | null
  errors: CompileIssue[]
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const ENFORCEMENT_VALUES: readonly Enforcement[] = ['observe', 'notify', 'ask', 'auto']
export const MAX_RESOURCES_CEILING = 10000
export const MAX_GRACE_PERIOD_DAYS = 365

const ENFORCEMENT_RANK: Record<Enforcement, number> = { observe: 0, notify: 1, ask: 2, auto: 3 }

export function enforcementRank(enforcement: Enforcement): number {
  return ENFORCEMENT_RANK[enforcement]
}

export function isEnforcement(value: unknown): value is Enforcement {
  return typeof value === 'string' && (ENFORCEMENT_VALUES as readonly string[]).includes(value)
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function nonEmptyString(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validateName(value: unknown, path: string, errors: CompileIssue[]): string | null {
  if (typeof value === 'string' && NAME_PATTERN.test(value)) return value
  errors.push(issue(path, 'NAME_INVALID', 'Name must be 1-64 chars: lowercase letters, digits and hyphens, starting with a letter or digit'))
  return null
}

function validateSpecList<T extends FilterSpec | ActionSpec>(
  value: unknown,
  path: string,
  code: string,
  errors: CompileIssue[],
): T[] | null {
  if (!Array.isArray(value)) {
    errors.push(issue(path, code, `${path} must be an array`))
    return null
  }
  const ok = value.every((item) => nonEmptyString(item) || isRecord(item))
  if (!ok) {
    errors.push(issue(path, code, `${path} entries must be a type name or an object`))
    return null
  }
  return value as T[]
}

function validateEnforcement(value: unknown, path: string, errors: CompileIssue[]): Enforcement | null {
  if (isEnforcement(value)) return value
  errors.push(issue(path, 'ENFORCEMENT_INVALID', `Enforcement must be one of ${ENFORCEMENT_VALUES.join(', ')}`))
  return null
}

function validateOptionalInt(
  source: UnknownRecord,
  key: string,
  min: number,
  max: number,
  code: string,
  errors: CompileIssue[],
): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (isIntInRange(value, min, max)) return value
  errors.push(issue(key, code, `${key} must be an integer between ${min} and ${max}`))
  return undefined
}

function validateTags(value: unknown, errors: CompileIssue[]): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const valid =
    isRecord(value) &&
    Object.entries(value).every(([k, v]) => nonEmptyString(k, 128) && typeof v === 'string' && v.length <= 256)
  if (valid) return { ...(value as Record<string, string>) }
  errors.push(issue('tags', 'TAGS_INVALID', 'tags must be a map of non-empty keys to string values'))
  return undefined
}

function validateOwnerTagKeys(value: unknown, errors: CompileIssue[]): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((k) => nonEmptyString(k, 128))) return [...value]
  errors.push(issue('ownerTagKeys', 'OWNER_TAG_KEYS_INVALID', 'ownerTagKeys must be an array of non-empty strings'))
  return undefined
}

function validateResource(value: unknown, errors: CompileIssue[]): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(issue('resource', 'RESOURCE_REQUIRED', 'resource is required'))
    return null
  }
  if (!isAllowedResource(value)) {
    errors.push(issue('resource', DENY_CODES.RESOURCE_NOT_ALLOWED, `Resource "${value}" is not in the allow-list`))
    return null
  }
  return normalizeResource(value)
}

export function validatePolicy(model: unknown): Validated<GovernancePolicy> {
  if (!isRecord(model)) {
    return { value: null, errors: [issue('', 'MODEL_INVALID', 'Policy must be an object')] }
  }
  const errors: CompileIssue[] = scanPolicyKeys(model)
  const name = validateName(model.name, 'name', errors)
  const resource = validateResource(model.resource, errors)
  const filters = validateSpecList<FilterSpec>(model.filters, 'filters', 'FILTERS_INVALID', errors)
  const actions = validateSpecList<ActionSpec>(model.actions, 'actions', 'ACTIONS_INVALID', errors)
  const enforcement = validateEnforcement(model.enforcement, 'enforcement', errors)
  if (model.provider !== 'aws') errors.push(issue('provider', 'PROVIDER_INVALID', 'provider must be "aws"'))
  if (model.description !== undefined && typeof model.description !== 'string') {
    errors.push(issue('description', 'DESCRIPTION_INVALID', 'description must be a string'))
  }
  const maxResources = validateOptionalInt(model, 'maxResources', 1, MAX_RESOURCES_CEILING, 'CAP_INVALID', errors)
  const maxResourcesPercent = validateOptionalInt(model, 'maxResourcesPercent', 1, 100, 'CAP_INVALID', errors)
  const gracePeriodDays = validateOptionalInt(model, 'gracePeriodDays', 0, MAX_GRACE_PERIOD_DAYS, 'GRACE_PERIOD_INVALID', errors)
  const ownerTagKeys = validateOwnerTagKeys(model.ownerTagKeys, errors)
  const tags = validateTags(model.tags, errors)

  if (errors.length > 0 || !name || !resource || !filters || !actions || !enforcement) {
    return { value: null, errors }
  }
  const value: GovernancePolicy = { name, provider: 'aws', resource, filters, actions, enforcement }
  if (typeof model.description === 'string') value.description = model.description
  if (maxResources !== undefined) value.maxResources = maxResources
  if (maxResourcesPercent !== undefined) value.maxResourcesPercent = maxResourcesPercent
  if (gracePeriodDays !== undefined) value.gracePeriodDays = gracePeriodDays
  if (ownerTagKeys) value.ownerTagKeys = ownerTagKeys
  if (tags) value.tags = tags
  return { value, errors }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))
}

export function validateException(model: unknown): Validated<PolicyException> {
  if (!isRecord(model)) {
    return { value: null, errors: [issue('', 'MODEL_INVALID', 'Exception must be an object')] }
  }
  const errors: CompileIssue[] = []
  const policy = validateName(model.policy, 'policy', errors)
  if (!nonEmptyString(model.resourceId, 2048)) {
    errors.push(issue('resourceId', 'RESOURCE_ID_INVALID', 'resourceId is required'))
  }
  if (!nonEmptyString(model.reason, 2000)) errors.push(issue('reason', 'REASON_REQUIRED', 'reason is required'))
  if (!nonEmptyString(model.approver, 320)) errors.push(issue('approver', 'APPROVER_REQUIRED', 'approver is required'))
  if (!isIsoDate(model.expiresAt)) {
    errors.push(issue('expiresAt', 'EXPIRES_AT_INVALID', 'expiresAt must be an ISO 8601 date'))
  }
  if (errors.length > 0 || !policy) return { value: null, errors }
  return {
    value: {
      policy,
      resourceId: (model.resourceId as string).trim(),
      reason: model.reason as string,
      approver: model.approver as string,
      expiresAt: model.expiresAt as string,
    },
    errors,
  }
}

const CRON_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]
const CRON_TOKEN = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/\d{1,2})?$/

function cronFieldValid(field: string, [min, max]: readonly [number, number]): boolean {
  return field.split(',').every((token) => {
    const match = CRON_TOKEN.exec(token)
    if (!match) return false
    const [base, step] = token.split('/')
    if (step !== undefined && Number(step) < 1) return false
    if (base === '*') return true
    const [from, to] = base.split('-').map(Number)
    return from >= min && from <= max && (to === undefined || (to >= from && to <= max))
  })
}

export function isValidCron(cron: unknown): cron is string {
  if (typeof cron !== 'string' || cron.length > 100) return false
  const fields = cron.trim().split(/\s+/)
  return fields.length === 5 && fields.every((field, i) => cronFieldValid(field, CRON_BOUNDS[i]))
}

export function validateSchedule(model: unknown): Validated<PolicySchedule> {
  if (!isRecord(model)) {
    return { value: null, errors: [issue('', 'MODEL_INVALID', 'Schedule must be an object')] }
  }
  const errors: CompileIssue[] = []
  const policy = validateName(model.policy, 'policy', errors)
  if (!isValidCron(model.cron)) {
    errors.push(issue('cron', 'CRON_INVALID', 'cron must be five fields of numbers, ranges, steps, lists or *'))
  }
  if (typeof model.enabled !== 'boolean') errors.push(issue('enabled', 'ENABLED_INVALID', 'enabled must be a boolean'))
  const enforcement = validateEnforcement(model.enforcement, 'enforcement', errors)
  if (errors.length > 0 || !policy || !enforcement) return { value: null, errors }
  return {
    value: { policy, cron: (model.cron as string).trim().split(/\s+/).join(' '), enabled: model.enabled as boolean, enforcement },
    errors,
  }
}

export function validatePack(model: unknown): Validated<PolicyPack> {
  if (!isRecord(model)) {
    return { value: null, errors: [issue('', 'MODEL_INVALID', 'Pack must be an object')] }
  }
  const errors: CompileIssue[] = []
  const name = validateName(model.name, 'name', errors)
  if (model.description !== undefined && typeof model.description !== 'string') {
    errors.push(issue('description', 'DESCRIPTION_INVALID', 'description must be a string'))
  }
  const members = model.policies
  if (!Array.isArray(members) || members.length === 0) {
    errors.push(issue('policies', 'PACK_POLICIES_INVALID', 'policies must be a non-empty array of policy names'))
  } else {
    const seen = new Set<string>()
    members.forEach((member, index) => {
      const path = `policies.${index}`
      if (validateName(member, path, errors) === null) return
      if (seen.has(member as string)) errors.push(issue(path, 'PACK_POLICY_DUPLICATE', `Policy "${member}" is listed twice`))
      seen.add(member as string)
    })
  }
  if (errors.length > 0 || !name) return { value: null, errors }
  const value: PolicyPack = { name, policies: [...(members as string[])] }
  if (typeof model.description === 'string') value.description = model.description
  return { value, errors }
}
