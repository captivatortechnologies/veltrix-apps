import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { hasAnyAssignment, type AssignmentSpec } from '../../lib/assignments'

/** The @odata.type of a Windows driver update profile — its own top-level collection. */
export const DRIVER_UPDATE_PROFILE_ODATA_TYPE = '#microsoft.graph.windowsDriverUpdateProfile'

/** driverUpdateProfileApprovalType — the full enum per Microsoft Learn (only two members). */
export const APPROVAL_TYPES = ['manual', 'automatic'] as const
export type DriverApprovalType = (typeof APPROVAL_TYPES)[number]

/**
 * Microsoft documents no maximum for deploymentDeferralInDays on the
 * windowsDriverUpdateProfile resource — only that it is an Int32 that applies
 * when approvalType is "automatic". Only a non-negative floor is enforced here
 * (the same convergent approach this app already takes for other Graph fields
 * with no documented upper bound, e.g. iOS MAM's minimumPinLength).
 */
export const DEPLOYMENT_DEFERRAL_MIN_DAYS = 0

export interface DriverUpdateProfileSpec {
  sectionName: string
  name: string
  description: string
  /**
   * The raw declared value (defaulted to 'manual' only when left blank) — NOT
   * pre-validated against APPROVAL_TYPES. An unrecognized value is deliberately
   * preserved here (rather than silently coerced) so `validate` can surface it
   * as an error, mirroring how the sibling windows-update-rings type validates
   * its own enum fields.
   */
  approvalType: string
  /** Undefined when left blank. Only meaningful (sent to Graph) when approvalType is 'automatic'. */
  deploymentDeferralInDays?: number
  assignments: AssignmentSpec
}

/** The profile display name is the reconciliation key. */
export function profileKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field; undefined when blank/non-numeric (so it is left unmanaged). */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a checkbox field; undefined when unset. */
function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no' || v === '') return false
  }
  return undefined
}

/**
 * Read the declared approvalType, defaulting to 'manual' only when the field is
 * left blank. An unrecognized non-blank value is passed through as-is so
 * `validate` can reject it (see DriverUpdateProfileSpec.approvalType).
 */
export function readApprovalType(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return 'manual'
}

// hasAnyAssignment lives once in lib/assignments (imported above); re-exported here
// for this type's deploy/drift/tests that import it from ./validate.
export { hasAnyAssignment }

/** Each canvas item is one driver update profile: name + approval/deferral + assignments. */
export function extractProfileSpecs(canvas: CanvasSnapshot): DriverUpdateProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.profile_name === 'string' ? fields.profile_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      approvalType: readApprovalType(fields.approvalType),
      deploymentDeferralInDays: readNumber(fields.deploymentDeferralInDays),
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices) ?? false,
        allUsers: false,
      },
    }
  })
}

/**
 * Build the create/PATCH body. deploymentDeferralInDays is only meaningful when
 * approvalType is 'automatic' (per the Graph resource docs); it is omitted
 * otherwise so a profile switched back to manual does not keep pushing a stale
 * deferral value that Intune will ignore.
 */
export function buildProfileBody(spec: DriverUpdateProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    '@odata.type': DRIVER_UPDATE_PROFILE_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    approvalType: spec.approvalType,
  }
  if (spec.approvalType === 'automatic' && spec.deploymentDeferralInDays !== undefined) {
    body.deploymentDeferralInDays = spec.deploymentDeferralInDays
  }
  return body
}

/**
 * Validate driver update profiles: each needs a unique name and a recognized
 * approval type. deploymentDeferralInDays, when set, must be a non-negative
 * integer, and is warned as ignored when the profile is in manual mode. A
 * profile with no assignment target is warned (it would apply to no devices).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no driver update profile items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.profile_name`, message: 'Profile name is required', code: 'required' })
    } else {
      const key = profileKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.profile_name`, message: `Duplicate profile name "${spec.name}"`, code: 'duplicate_profile' })
      }
      seen.add(key)
    }

    if (!(APPROVAL_TYPES as readonly string[]).includes(spec.approvalType)) {
      errors.push({
        field: `${prefix}.approvalType`,
        message: `Approval type must be one of ${APPROVAL_TYPES.join(', ')}`,
        code: 'invalid_approval_type',
      })
    }

    if (spec.deploymentDeferralInDays !== undefined) {
      if (!Number.isInteger(spec.deploymentDeferralInDays) || spec.deploymentDeferralInDays < DEPLOYMENT_DEFERRAL_MIN_DAYS) {
        errors.push({
          field: `${prefix}.deploymentDeferralInDays`,
          message: `Deployment deferral (days) must be a whole number of at least ${DEPLOYMENT_DEFERRAL_MIN_DAYS}`,
          code: 'out_of_range',
        })
      } else if (spec.approvalType === 'manual') {
        warnings.push({
          field: `${prefix}.deploymentDeferralInDays`,
          message: 'Deployment deferral only applies when approval type is "Automatic" — it is set but will be ignored while approval type is "Manual"',
          code: 'ignored_when_manual',
        })
      }
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Profile has no assignment — add include groups or target all devices, or it will apply to nothing',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
