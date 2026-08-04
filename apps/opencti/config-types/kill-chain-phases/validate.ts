import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate kill-chain-phase items: a non-empty kill chain name, a non-empty
 * phase name and a non-negative integer order. Static — no target access
 * required. `kill_chain_name` + `phase_name` together are the compound
 * identity, so a duplicate PAIR is flagged (last one wins) — the same phase
 * name may legitimately repeat across different kill chains.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one kill-chain phase.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const killChainName = String(item.fields.kill_chain_name ?? '').trim()
    const phaseName = String(item.fields.phase_name ?? '').trim()
    const orderRaw = item.fields.x_opencti_order

    if (!killChainName) {
      errors.push({
        field: `items[${i}].kill_chain_name`,
        message: 'Kill chain name is required.',
        code: 'EMPTY_KILL_CHAIN_NAME',
      })
    }

    if (!phaseName) {
      errors.push({ field: `items[${i}].phase_name`, message: 'Phase name is required.', code: 'EMPTY_PHASE_NAME' })
    }

    if (killChainName && phaseName) {
      const key = `${killChainName.toLowerCase()}::${phaseName.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].phase_name`,
          message: `Kill chain "${killChainName}" phase "${phaseName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_KILL_CHAIN_PHASE',
        })
      } else {
        seen.add(key)
      }
    }

    if (orderRaw !== undefined && orderRaw !== null && orderRaw !== '') {
      const order = Number(orderRaw)
      if (!Number.isFinite(order) || order < 0 || !Number.isInteger(order)) {
        errors.push({
          field: `items[${i}].x_opencti_order`,
          message: `Order "${String(orderRaw)}" must be a non-negative integer.`,
          code: 'INVALID_ORDER',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
