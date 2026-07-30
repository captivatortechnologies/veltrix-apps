import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate the agent-config singleton: agentOptions must be present and valid
 * JSON (it becomes the org-wide agent_options). Static — no target access
 * required. There should be exactly one item; extras warn (only the first
 * applies).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the agent configuration.', code: 'EMPTY' })
  } else if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Agent configuration is a singleton; only the first item is applied.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const raw = String(item.fields.agentOptions ?? '').trim()
    if (!raw) {
      errors.push({ field: `items[${i}].agentOptions`, message: 'Agent Options (JSON) is required.', code: 'EMPTY_AGENT_OPTIONS' })
      return
    }
    try {
      JSON.parse(raw)
    } catch (e) {
      errors.push({ field: `items[${i}].agentOptions`, message: `Agent Options must be valid JSON: ${e instanceof Error ? e.message : 'parse error'}.`, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
