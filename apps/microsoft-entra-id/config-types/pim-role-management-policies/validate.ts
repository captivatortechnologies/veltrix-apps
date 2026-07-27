import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra PIM role-management-policy (rule) constraints ---------------------
//
// Scope: the Directory-scope policy for a chosen role is resolved via its
// roleManagementPolicyAssignment, then three end-user ACTIVATION rules are
// managed by PATCH (no create/delete): the enablement rule (MFA / justification /
// ticketing to activate), the expiration rule (max activation duration) and the
// approval rule (whether approval is required — merged into the live setting so
// approval stages are preserved). Other rules (notifications, admin/eligibility
// rules) are left untouched.

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const ISO8601_DURATION_RE = /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/

export const RULE_IDS = {
  enablement: 'Enablement_EndUser_Assignment',
  expiration: 'Expiration_EndUser_Assignment',
  approval: 'Approval_EndUser_Assignment',
} as const

export const RULE_ODATA_TYPES = {
  enablement: '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule',
  expiration: '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
  approval: '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule',
} as const

export interface PimPolicySpec {
  itemId?: string
  /** roleDefinitionId — the logical identity; the Directory-scope policy is resolved from it. */
  roleDefinitionId: string
  requireMfaOnActivation: boolean
  requireJustificationOnActivation: boolean
  requireTicketingOnActivation: boolean
  requireApprovalToActivate: boolean
  activationExpirationRequired: boolean
  activationMaximumDuration: string
}

/** A unifiedRoleManagementPolicyRule as returned by Graph (union across subtypes). */
export interface LivePimRule {
  id?: string
  '@odata.type'?: string
  enabledRules?: string[]
  isExpirationRequired?: boolean
  maximumDuration?: string
  setting?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** The enabledRules array the enablement rule should carry, from the spec toggles. */
export function desiredEnabledRules(spec: PimPolicySpec): string[] {
  const out: string[] = []
  if (spec.requireMfaOnActivation) out.push('MultiFactorAuthentication')
  if (spec.requireJustificationOnActivation) out.push('Justification')
  if (spec.requireTicketingOnActivation) out.push('Ticketing')
  return out
}

export function extractPimPolicySpecs(canvas: CanvasSnapshot): PimPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      roleDefinitionId: asString(f.roleDefinitionId),
      requireMfaOnActivation: asBool(f.requireMfaOnActivation),
      requireJustificationOnActivation: asBool(f.requireJustificationOnActivation),
      requireTicketingOnActivation: asBool(f.requireTicketingOnActivation),
      requireApprovalToActivate: asBool(f.requireApprovalToActivate),
      activationExpirationRequired: asBool(f.activationExpirationRequired),
      activationMaximumDuration: asString(f.activationMaximumDuration),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPimPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.roleDefinitionId) {
      errors.push({ field: `${prefix}.roleDefinitionId`, message: 'Role definition id is required', code: 'required' })
    } else {
      if (!GUID_RE.test(spec.roleDefinitionId)) {
        errors.push({ field: `${prefix}.roleDefinitionId`, message: 'Role definition id must be a GUID (a role template id)', code: 'invalid_role_id' })
      }
      const key = spec.roleDefinitionId.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.roleDefinitionId`, message: `Duplicate role "${spec.roleDefinitionId}" — each may only be declared once per canvas`, code: 'duplicate_role' })
      }
      seen.add(key)
    }

    if (spec.activationExpirationRequired && !spec.activationMaximumDuration) {
      errors.push({ field: `${prefix}.activationMaximumDuration`, message: 'Maximum activation duration is required when expiration is required', code: 'duration_required' })
    }
    if (spec.activationMaximumDuration && !ISO8601_DURATION_RE.test(spec.activationMaximumDuration)) {
      errors.push({ field: `${prefix}.activationMaximumDuration`, message: 'Maximum activation duration must be an ISO 8601 duration (e.g. PT8H)', code: 'invalid_duration' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
