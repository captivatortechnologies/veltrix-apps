import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra authentication-flows-policy constraints ---------------------------

export interface AuthFlowsSpec {
  itemId?: string
  selfServiceSignUpEnabled: boolean
}

/** The authentication flows policy singleton as returned by Graph. */
export interface LiveAuthFlowsPolicy {
  selfServiceSignUp?: { isEnabled?: boolean }
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractAuthFlowsSpecs(canvas: CanvasSnapshot): AuthFlowsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return { itemId: item.id, selfServiceSignUpEnabled: asBool(f.selfServiceSignUpEnabled) }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAuthFlowsSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'The authentication flows policy is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
