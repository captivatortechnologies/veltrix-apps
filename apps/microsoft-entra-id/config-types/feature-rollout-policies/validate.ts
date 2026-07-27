import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra feature-rollout-policy constraints --------------------------------
//
// Scope: manages the policy scalars (feature, enablement, org-wide application).
// The appliesTo group targeting is NOT managed by this type.

export const MAX_DISPLAY_NAME_LENGTH = 256

export const ROLLOUT_FEATURES = new Set([
  'passthroughAuthentication',
  'seamlessSso',
  'passwordHashSync',
  'emailAsAlternateId',
  'certificateBasedAuthentication',
  'multiFactorAuthentication',
])

export interface FeatureRolloutSpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  feature: string
  isEnabled: boolean
  isAppliedToOrganization: boolean
}

/** A feature rollout policy as returned by Graph. */
export interface LiveFeatureRolloutPolicy {
  id?: string
  displayName?: string
  feature?: string
  isEnabled?: boolean
  isAppliedToOrganization?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractFeatureRolloutSpecs(canvas: CanvasSnapshot): FeatureRolloutSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      feature: asString(f.feature),
      isEnabled: asBool(f.isEnabled),
      isAppliedToOrganization: asBool(f.isAppliedToOrganization),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFeatureRolloutSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate feature rollout policy "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.feature) {
      errors.push({ field: `${prefix}.feature`, message: 'Feature is required', code: 'required' })
    } else if (!ROLLOUT_FEATURES.has(spec.feature)) {
      errors.push({
        field: `${prefix}.feature`,
        message: `Feature "${spec.feature}" is not one of ${[...ROLLOUT_FEATURES].join(', ')}`,
        code: 'invalid_feature',
      })
    }

    if (!spec.isAppliedToOrganization) {
      warnings.push({
        field: `${prefix}.isAppliedToOrganization`,
        message: 'This type does not manage appliesTo group targeting — without organization-wide application the policy targets no one',
        code: 'no_targets',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
