import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra access-package assignment-policy constraints ----------------------
//
// Nested under an access package (resolved by package display name). The nested
// setting objects (expiration, requestor, approval) are managed as JSON blobs.

export const MAX_DISPLAY_NAME_LENGTH = 256
export const ALLOWED_TARGET_SCOPES = new Set([
  'notSpecified',
  'specificDirectoryUsers',
  'specificConnectedOrganizationUsers',
  'allMemberUsers',
  'allDirectoryUsers',
  'allConfiguredConnectedOrganizationUsers',
  'allExternalUsers',
])

export interface AssignmentPolicySpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  /** The display name of the access package this policy belongs to. */
  accessPackageName: string
  description: string
  allowedTargetScope: string
  expiration: string
  requestorSettings: string
  requestApprovalSettings: string
}

/** An access package assignment policy as returned by Graph. */
export interface LiveAssignmentPolicy {
  id?: string
  displayName?: string
  description?: string | null
  allowedTargetScope?: string
  expiration?: unknown
  requestorSettings?: unknown
  requestApprovalSettings?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseObject(text: string): Record<string, unknown> | null {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
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
  return JSON.stringify(sortValue(v ?? {}))
}

export function extractAssignmentPolicySpecs(canvas: CanvasSnapshot): AssignmentPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      accessPackageName: asString(f.accessPackageName),
      description: asString(f.description),
      allowedTargetScope: asString(f.allowedTargetScope) || 'notSpecified',
      expiration: asString(f.expiration),
      requestorSettings: asString(f.requestorSettings),
      requestApprovalSettings: asString(f.requestApprovalSettings),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAssignmentPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    else if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.accessPackageName) {
      errors.push({ field: `${prefix}.accessPackageName`, message: 'Access package name is required', code: 'required' })
    }

    if (!ALLOWED_TARGET_SCOPES.has(spec.allowedTargetScope)) {
      errors.push({
        field: `${prefix}.allowedTargetScope`,
        message: `allowedTargetScope must be one of ${[...ALLOWED_TARGET_SCOPES].join(', ')}`,
        code: 'invalid_target_scope',
      })
    }

    for (const field of ['expiration', 'requestorSettings', 'requestApprovalSettings'] as const) {
      if (spec[field] && !parseObject(spec[field])) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must be a valid JSON object`, code: 'invalid_json' })
      }
    }

    if (spec.name && spec.accessPackageName) {
      const key = `${spec.accessPackageName.toLowerCase()}|${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}" for package "${spec.accessPackageName}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
