import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black device-control block (per-policy enforcement) constraints ---

export interface BlockSpec {
  itemId?: string
  /** policyName — resolved to a policy_id; the block's identity is one-per-policy. */
  policyName: string
  /** allow approved devices to be written to (read is always allowed). */
  allowWrite: boolean
  /** allow execution from approved devices. */
  allowExecute: boolean
}

/** A device-control block as returned by the device-control service. */
export interface LiveBlock {
  id?: string
  policy_id?: number | string
  windows?: {
    approved_devices?: {
      allow_write?: boolean
      allow_execute?: boolean
    }
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractBlockSpecs(canvas: CanvasSnapshot): BlockSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      policyName: asString(f.policyName) || item.name,
      allowWrite: asBool(f.allowWrite),
      allowExecute: asBool(f.allowExecute),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractBlockSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.policyName) {
      errors.push({ field: `${prefix}.policyName`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = spec.policyName.toLowerCase()
      // One block per policy — two items for the same policy conflict.
      if (seen.has(key)) errors.push({ field: `${prefix}.policyName`, message: `Duplicate block for policy "${spec.policyName}"`, code: 'duplicate_policy' })
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
