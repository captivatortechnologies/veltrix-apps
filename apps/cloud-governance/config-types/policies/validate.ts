import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { evaluatePolicyItem } from '../lib/policyItem'
import { toErrors, toWarnings } from '../lib/results'
import { validateItems } from '../lib/validation'

/**
 * Compiles every item WITHOUT exceptions: validate runs with no governance
 * store (the handler context carries none), so tenant exceptions are applied
 * at deploy time only. Shape, deny-list and JSON problems all surface here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateItems(ctx, {
    label: 'policy',
    duplicateMessage: (name) => `Policy "${name}" is declared more than once.`,
    check: (item, prefix) => {
      const evaluation = evaluatePolicyItem(item)
      const name = typeof evaluation.item.model.name === 'string' ? evaluation.item.model.name : ''
      return {
        identity: name === '' ? null : name,
        errors: toErrors(prefix, evaluation.errors),
        warnings: toWarnings(prefix, evaluation.warnings),
      }
    },
  })
}
