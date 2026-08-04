import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra access-review schedule-definition constraints ---------------------
//
// scope is decomposed by "Scope Type" into one live-picker field per
// documented accessReviewScope shape (see canvas.yaml + deploy.ts for the
// exact Graph query strings, each cited against Microsoft's own worked
// examples), with a JSON escape hatch ("custom") for every other shape.
// reviewers/fallbackReviewers are decomposed into typed picker fields whose
// entries are appended to an optional JSON array. settings stays JSON — it is
// pure scalar/enum data (recurrence, defaultDecision, ...) with no directory
// references to wire.

export const MAX_DISPLAY_NAME_LENGTH = 256

export const SCOPE_TYPES = new Set(['groupMembership', 'directoryRole', 'accessPackageAssignments', 'applicationAccess', 'custom'])

export interface AccessReviewSpec {
  itemId?: string
  /** displayName — the logical identity live definitions are matched on. */
  name: string
  descriptionForAdmins: string

  scopeType: string
  scopeGroupId: string
  scopeRoleDefinitionId: string
  scopeAccessPackageId: string
  scopeServicePrincipalId: string
  scopeCustomJson: string
  instanceEnumerationScopeJson: string

  reviewerUsers: string[]
  reviewerGroupOwners: string[]
  reviewerManagersSelfReview: boolean
  reviewersCustomJson: string
  fallbackReviewerUsers: string[]
  fallbackReviewerGroupOwners: string[]
  fallbackReviewersCustomJson: string

  settings: string
}

/** An access review schedule definition as returned by Graph. */
export interface LiveAccessReview {
  id?: string
  displayName?: string
  descriptionForAdmins?: string | null
  scope?: unknown
  instanceEnumerationScope?: unknown
  reviewers?: unknown
  fallbackReviewers?: unknown
  settings?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
}

export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function parseArray(text: string): unknown[] | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? null))
}

export function extractAccessReviewSpecs(canvas: CanvasSnapshot): AccessReviewSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      descriptionForAdmins: asString(f.descriptionForAdmins),

      scopeType: asString(f.scopeType) || 'groupMembership',
      scopeGroupId: asString(f.scopeGroupId),
      scopeRoleDefinitionId: asString(f.scopeRoleDefinitionId),
      scopeAccessPackageId: asString(f.scopeAccessPackageId),
      scopeServicePrincipalId: asString(f.scopeServicePrincipalId),
      scopeCustomJson: asString(f.scopeCustomJson),
      instanceEnumerationScopeJson: asString(f.instanceEnumerationScopeJson),

      reviewerUsers: asStringArray(f.reviewerUsers),
      reviewerGroupOwners: asStringArray(f.reviewerGroupOwners),
      reviewerManagersSelfReview: asBool(f.reviewerManagersSelfReview),
      reviewersCustomJson: asString(f.reviewersCustomJson),
      fallbackReviewerUsers: asStringArray(f.fallbackReviewerUsers),
      fallbackReviewerGroupOwners: asStringArray(f.fallbackReviewerGroupOwners),
      fallbackReviewersCustomJson: asString(f.fallbackReviewersCustomJson),

      settings: asString(f.settings),
    }
  })
}

/** The scope-defining field required for a given (non-custom) scopeType. */
function requiredScopeField(scopeType: string): keyof AccessReviewSpec | null {
  switch (scopeType) {
    case 'groupMembership':
      return 'scopeGroupId'
    case 'directoryRole':
      return 'scopeRoleDefinitionId'
    case 'accessPackageAssignments':
      return 'scopeAccessPackageId'
    case 'applicationAccess':
      return 'scopeServicePrincipalId'
    default:
      return null
  }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccessReviewSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate access review "${spec.name}"`, code: 'duplicate_name' })
      seenNames.add(key)
    }

    if (!SCOPE_TYPES.has(spec.scopeType)) {
      errors.push({
        field: `${prefix}.scopeType`,
        message: `scopeType must be one of ${[...SCOPE_TYPES].join(', ')}`,
        code: 'invalid_scope_type',
      })
    } else if (spec.scopeType === 'custom') {
      if (!parseObject(spec.scopeCustomJson)) {
        errors.push({ field: `${prefix}.scopeCustomJson`, message: 'Custom Scope (JSON) is required and must be a valid JSON object when Scope Type is "Custom"', code: 'invalid_scope' })
      }
      if (spec.instanceEnumerationScopeJson && !parseObject(spec.instanceEnumerationScopeJson)) {
        errors.push({ field: `${prefix}.instanceEnumerationScopeJson`, message: 'Custom Instance Enumeration Scope (JSON) must be a valid JSON object', code: 'invalid_json' })
      }
    } else {
      const field = requiredScopeField(spec.scopeType)
      if (field && !spec[field]) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} is required when Scope Type is "${spec.scopeType}"`, code: 'required' })
      }
    }

    if (spec.reviewersCustomJson && !parseArray(spec.reviewersCustomJson)) {
      errors.push({ field: `${prefix}.reviewersCustomJson`, message: 'Additional Reviewers (JSON) must be a valid JSON array', code: 'invalid_json' })
    }
    if (spec.fallbackReviewersCustomJson && !parseArray(spec.fallbackReviewersCustomJson)) {
      errors.push({ field: `${prefix}.fallbackReviewersCustomJson`, message: 'Additional Fallback Reviewers (JSON) must be a valid JSON array', code: 'invalid_json' })
    }

    if (!parseObject(spec.settings)) {
      errors.push({ field: `${prefix}.settings`, message: 'Settings is required and must be a valid JSON object', code: 'invalid_settings' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
