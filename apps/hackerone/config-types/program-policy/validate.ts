import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str } from './_shared'

/**
 * Validate program-policy items: each needs a program handle and non-empty
 * policy text. Static — no target access required. Identity is program_handle
 * (one policy document per program), so a program declared more than once is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one program policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const programHandle = str(item.fields.program_handle)
    const policy = str(item.fields.policy)

    if (!programHandle) {
      errors.push({ field: `items[${i}].program_handle`, message: 'Program handle is required.', code: 'EMPTY_PROGRAM' })
    } else {
      const key = programHandle.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].program_handle`,
          message: `Program "${programHandle}" has more than one policy declared; the last one wins.`,
          code: 'DUPLICATE_PROGRAM',
        })
      } else {
        seen.add(key)
      }
    }

    if (!policy) {
      errors.push({ field: `items[${i}].policy`, message: 'Policy text is required.', code: 'EMPTY_POLICY' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
