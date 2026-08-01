import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseQuestionId } from './_shared'

/**
 * Validate saved-question items: a non-empty name and a question — either the
 * question text OR a pre-parsed Question ID (which must be a positive integer).
 * Static — no target access required. The name is the group identity, so a
 * duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one saved question.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const questionText = String(item.fields.questionText ?? '').trim()
    const questionIdRaw = String(item.fields.questionId ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Saved question name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Saved question name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!questionText && !questionIdRaw) {
      errors.push({
        field: `items[${i}].questionText`,
        message: 'Provide the question text or a pre-parsed Question ID so the saved question has a question.',
        code: 'NO_QUESTION',
      })
    }

    if (questionIdRaw) {
      const parsed = parseQuestionId(questionIdRaw)
      if (parsed.error) {
        errors.push({ field: `items[${i}].questionId`, message: parsed.error, code: 'INVALID_QUESTION_ID' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
