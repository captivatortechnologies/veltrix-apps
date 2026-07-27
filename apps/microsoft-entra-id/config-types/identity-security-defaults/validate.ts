import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra security-defaults enforcement policy constraints ------------------

export interface SecurityDefaultsSpec {
  itemId?: string
  isEnabled: boolean
}

/** The security defaults enforcement policy singleton as returned by Graph. */
export interface LiveSecurityDefaults {
  id?: string
  isEnabled?: boolean
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractSecurityDefaultsSpecs(canvas: CanvasSnapshot): SecurityDefaultsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return { itemId: item.id, isEnabled: asBool(f.isEnabled) }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSecurityDefaultsSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'Security defaults is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  if (specs[0]?.isEnabled) {
    warnings.push({
      field: 'items[0].isEnabled',
      message:
        'Security defaults is mutually exclusive with Conditional Access — enabling it blocks all Conditional Access policies',
      code: 'mutually_exclusive',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
