import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SEVERITIES } from './_shared'

/**
 * Validate posture-control items: a non-empty unique name, resourceKind,
 * severity, rego and remediationDetails. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one posture control.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Control name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: p('name'), message: `Control name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!String(item.fields.description ?? '').trim()) {
      errors.push({ field: p('description'), message: 'Description is required.', code: 'EMPTY_DESCRIPTION' })
    }
    if (!String(item.fields.resourceKind ?? '').trim()) {
      errors.push({ field: p('resourceKind'), message: 'Resource Kind is required.', code: 'EMPTY_RESOURCE_KIND' })
    }
    const severity = String(item.fields.severity ?? '').trim()
    if (!SEVERITIES.has(severity)) {
      errors.push({ field: p('severity'), message: `Severity must be one of ${[...SEVERITIES].join(', ')} (got "${severity}").`, code: 'INVALID_SEVERITY' })
    }
    if (!String(item.fields.rego ?? '').trim()) {
      errors.push({ field: p('rego'), message: 'Rego is required.', code: 'EMPTY_REGO' })
    }
    if (!String(item.fields.remediationDetails ?? '').trim()) {
      errors.push({ field: p('remediationDetails'), message: 'Remediation Details is required.', code: 'EMPTY_REMEDIATION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
