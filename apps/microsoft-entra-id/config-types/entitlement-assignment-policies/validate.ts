import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra access-package assignment-policy constraints ----------------------
//
// Nested under an access package (resolved by id or, for a pre-picker canvas,
// package display name). requestorSettings/requestApprovalSettings are
// decomposed into typed flags + single-kind subjectSet pickers (see
// canvas.yaml and deploy.ts); approvalStagesOverride remains a JSON escape
// hatch for multi-stage/escalation approval. specificAllowedTargets is wired
// directly per allowedTargetScope's "specific*" values.

export const MAX_DISPLAY_NAME_LENGTH = 256

/**
 * accessPackageAssignmentPolicy.allowedTargetScope
 * (https://learn.microsoft.com/graph/api/resources/accesspackageassignmentpolicy).
 * `unknownFutureValue` is a forward-compatibility read-only sentinel and is
 * deliberately not offered here — the same "don't offer what a client should
 * never set" rule this app's CLOUD_APP_SENTINELS/CA-sentinel comments already
 * document for other enums.
 */
export const ALLOWED_TARGET_SCOPES = new Set([
  'notSpecified',
  'specificDirectoryUsers',
  'specificConnectedOrganizationUsers',
  'specificDirectoryServicePrincipals',
  'allMemberUsers',
  'allDirectoryUsers',
  'allDirectoryServicePrincipals',
  'allConfiguredConnectedOrganizationUsers',
  'allExternalUsers',
  'allDirectoryAgentIdentities',
])

/** allowedTargetScope values that require specificAllowedTargets to be non-empty. */
const SPECIFIC_SCOPES = new Set([
  'specificDirectoryUsers',
  'specificConnectedOrganizationUsers',
  'specificDirectoryServicePrincipals',
])

export interface AssignmentPolicySpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  /** Access package id (picker-stored) or a hand-typed package display name, resolved at deploy time. */
  accessPackageId: string
  description: string
  allowedTargetScope: string
  expiration: string

  specificTargetUsers: string[]
  specificTargetGroups: string[]
  specificTargetServicePrincipals: string[]
  specificTargetConnectedOrganizations: string[]

  enableTargetsToSelfAddAccess: boolean
  enableTargetsToSelfUpdateAccess: boolean
  enableTargetsToSelfRemoveAccess: boolean
  allowCustomAssignmentSchedule: boolean
  enableOnBehalfRequestorsToAddAccess: boolean
  enableOnBehalfRequestorsToUpdateAccess: boolean
  enableOnBehalfRequestorsToRemoveAccess: boolean
  onBehalfRequestorUsers: string[]
  onBehalfRequestorGroups: string[]
  onBehalfRequestorServicePrincipals: string[]

  isApprovalRequiredForAdd: boolean
  isApprovalRequiredForUpdate: boolean
  isRequestorJustificationRequired: boolean
  primaryApproverUsers: string[]
  primaryApproverGroups: string[]
  approvalStagesOverride: string
}

/** An access package assignment policy as returned by Graph. */
export interface LiveAssignmentPolicy {
  id?: string
  displayName?: string
  description?: string | null
  allowedTargetScope?: string
  expiration?: unknown
  specificAllowedTargets?: unknown
  requestorSettings?: {
    enableTargetsToSelfAddAccess?: boolean
    enableTargetsToSelfUpdateAccess?: boolean
    enableTargetsToSelfRemoveAccess?: boolean
    allowCustomAssignmentSchedule?: boolean
    enableOnBehalfRequestorsToAddAccess?: boolean
    enableOnBehalfRequestorsToUpdateAccess?: boolean
    enableOnBehalfRequestorsToRemoveAccess?: boolean
    onBehalfRequestors?: unknown[]
  } | null
  requestApprovalSettings?: {
    isApprovalRequiredForAdd?: boolean
    isApprovalRequiredForUpdate?: boolean
    isRequestorJustificationRequired?: boolean
    stages?: unknown[]
  } | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return fallback
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
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
      accessPackageId: asString(f.accessPackageId),
      description: asString(f.description),
      allowedTargetScope: asString(f.allowedTargetScope) || 'notSpecified',
      expiration: asString(f.expiration),

      specificTargetUsers: asStringArray(f.specificTargetUsers),
      specificTargetGroups: asStringArray(f.specificTargetGroups),
      specificTargetServicePrincipals: asStringArray(f.specificTargetServicePrincipals),
      specificTargetConnectedOrganizations: asStringArray(f.specificTargetConnectedOrganizations),

      enableTargetsToSelfAddAccess: asBool(f.enableTargetsToSelfAddAccess, true),
      enableTargetsToSelfUpdateAccess: asBool(f.enableTargetsToSelfUpdateAccess, false),
      enableTargetsToSelfRemoveAccess: asBool(f.enableTargetsToSelfRemoveAccess, false),
      allowCustomAssignmentSchedule: asBool(f.allowCustomAssignmentSchedule, true),
      enableOnBehalfRequestorsToAddAccess: asBool(f.enableOnBehalfRequestorsToAddAccess, false),
      enableOnBehalfRequestorsToUpdateAccess: asBool(f.enableOnBehalfRequestorsToUpdateAccess, false),
      enableOnBehalfRequestorsToRemoveAccess: asBool(f.enableOnBehalfRequestorsToRemoveAccess, false),
      onBehalfRequestorUsers: asStringArray(f.onBehalfRequestorUsers),
      onBehalfRequestorGroups: asStringArray(f.onBehalfRequestorGroups),
      onBehalfRequestorServicePrincipals: asStringArray(f.onBehalfRequestorServicePrincipals),

      isApprovalRequiredForAdd: asBool(f.isApprovalRequiredForAdd, false),
      isApprovalRequiredForUpdate: asBool(f.isApprovalRequiredForUpdate, false),
      isRequestorJustificationRequired: asBool(f.isRequestorJustificationRequired, true),
      primaryApproverUsers: asStringArray(f.primaryApproverUsers),
      primaryApproverGroups: asStringArray(f.primaryApproverGroups),
      approvalStagesOverride: asString(f.approvalStagesOverride),
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

    if (!spec.accessPackageId) {
      errors.push({ field: `${prefix}.accessPackageId`, message: 'Access package is required', code: 'required' })
    }

    if (!ALLOWED_TARGET_SCOPES.has(spec.allowedTargetScope)) {
      errors.push({
        field: `${prefix}.allowedTargetScope`,
        message: `allowedTargetScope must be one of ${[...ALLOWED_TARGET_SCOPES].join(', ')}`,
        code: 'invalid_target_scope',
      })
    } else if (SPECIFIC_SCOPES.has(spec.allowedTargetScope)) {
      const hasAnyTarget =
        spec.specificTargetUsers.length > 0 ||
        spec.specificTargetGroups.length > 0 ||
        spec.specificTargetServicePrincipals.length > 0 ||
        spec.specificTargetConnectedOrganizations.length > 0
      if (!hasAnyTarget) {
        warnings.push({
          field: `${prefix}.allowedTargetScope`,
          message: `allowedTargetScope "${spec.allowedTargetScope}" requires at least one Specific Targets field — leaving all empty targets nobody`,
          code: 'empty_specific_targets',
        })
      }
    }

    if (spec.expiration && !parseObject(spec.expiration)) {
      errors.push({ field: `${prefix}.expiration`, message: 'expiration must be a valid JSON object', code: 'invalid_json' })
    }

    if (spec.approvalStagesOverride && !parseArray(spec.approvalStagesOverride)) {
      errors.push({
        field: `${prefix}.approvalStagesOverride`,
        message: 'approvalStagesOverride must be a valid JSON array',
        code: 'invalid_json',
      })
    }

    if (spec.name && spec.accessPackageId) {
      const key = `${spec.accessPackageId.toLowerCase()}|${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}" for package "${spec.accessPackageId}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
