import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra external (social) identity-provider constraints -------------------
//
// clientSecret is write-only (Graph never returns it), so it is always sent on
// deploy but is not compared by drift detection.

export const SOCIAL_ODATA_TYPE = '#microsoft.graph.socialIdentityProvider'
export const MAX_DISPLAY_NAME_LENGTH = 256

export interface IdentityProviderSpec {
  itemId?: string
  /** displayName — the logical identity live providers are matched on. */
  name: string
  identityProviderType: string
  clientId: string
  clientSecret: string
}

/** A social identity provider as returned by Graph (clientSecret is never returned). */
export interface LiveIdentityProvider {
  id?: string
  displayName?: string
  identityProviderType?: string
  clientId?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractIdentityProviderSpecs(canvas: CanvasSnapshot): IdentityProviderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      identityProviderType: asString(f.identityProviderType),
      clientId: asString(f.clientId),
      clientSecret: asString(f.clientSecret),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIdentityProviderSpecs(ctx.canvas)
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
          message: `Duplicate identity provider "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.identityProviderType) {
      errors.push({ field: `${prefix}.identityProviderType`, message: 'Identity provider type is required (e.g. Google, Facebook, GitHub)', code: 'required' })
    }
    if (!spec.clientId) {
      errors.push({ field: `${prefix}.clientId`, message: 'Client ID is required', code: 'required' })
    }
    if (!spec.clientSecret) {
      errors.push({ field: `${prefix}.clientSecret`, message: 'Client secret is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
