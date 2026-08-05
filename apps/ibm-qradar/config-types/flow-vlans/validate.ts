import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar flow VLAN constraints ------------------------------------------
//
// POST /ariel/flow_vlans creates a (enterprise_vlan_id, customer_vlan_id) pair;
// GET lists them; DELETE /ariel/flow_vlans/{id} removes one. There is NO name
// field and NO update endpoint, so the pair itself is the identity — deploy
// matches live entries on (enterprise_vlan_id, customer_vlan_id), not on the
// canvas item id. Changing either id is therefore a natural delete+recreate.

export interface FlowVlanSpec {
  itemId?: string
  /** canvas-only display label; never sent to QRadar. */
  label: string
  /** 0-4095; 0 means "non-existent" (no enterprise VLAN field for this pair). */
  enterpriseVlanId: number
  /** 1-4095. */
  customerVlanId: number
}

/** A flow VLAN pair as returned by GET /ariel/flow_vlans. */
export interface LiveFlowVlan {
  id?: number
  enterprise_vlan_id?: number
  customer_vlan_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return fallback
}

/** The pair's identity key, used to match live entries regardless of canvas item id. */
export function vlanKey(spec: { enterpriseVlanId: number; customerVlanId: number }): string {
  return `${spec.enterpriseVlanId}:${spec.customerVlanId}`
}

export function extractFlowVlanSpecs(canvas: CanvasSnapshot): FlowVlanSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      label: asString(f.label) || item.name,
      enterpriseVlanId: asInt(f.enterpriseVlanId, 0),
      customerVlanId: asInt(f.customerVlanId, 0),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFlowVlanSpecs(ctx.canvas)
  const seenLabels = new Set<string>()
  const seenPairs = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Label is required', code: 'required' })
    } else {
      const key = spec.label.toLowerCase()
      if (seenLabels.has(key)) {
        errors.push({ field: `${prefix}.label`, message: `Duplicate label "${spec.label}"`, code: 'duplicate_label' })
      }
      seenLabels.add(key)
    }

    if (spec.enterpriseVlanId < 0 || spec.enterpriseVlanId > 4095) {
      errors.push({ field: `${prefix}.enterpriseVlanId`, message: 'Enterprise VLAN ID must be between 0 and 4095', code: 'out_of_range' })
    }
    if (spec.customerVlanId < 1 || spec.customerVlanId > 4095) {
      errors.push({ field: `${prefix}.customerVlanId`, message: 'Customer VLAN ID must be between 1 and 4095', code: 'out_of_range' })
    }

    const pairKey = vlanKey(spec)
    if (seenPairs.has(pairKey)) {
      errors.push({ field: `${prefix}.customerVlanId`, message: `Duplicate VLAN pair (enterprise ${spec.enterpriseVlanId}, customer ${spec.customerVlanId})`, code: 'duplicate_pair' })
    }
    seenPairs.add(pairKey)
  })

  return { valid: errors.length === 0, errors, warnings }
}
