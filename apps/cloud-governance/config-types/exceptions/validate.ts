import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateException } from '../../lib/model'
import { exceptionKey, readExceptionItem } from '../lib/guardrailItems'
import { toErrors } from '../lib/results'
import { validateItems } from '../lib/validation'
import { isExpired } from './_shared'

/**
 * Shape and uniqueness of (policy, resource). An exception that is already
 * expired is accepted but flagged: it would be stored and never applied.
 * Whether the policy exists needs the store, so deploy warns about that.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const now = new Date()
  return validateItems(ctx, {
    label: 'exception',
    duplicateMessage: (key) => `An exception for ${key} is declared more than once.`,
    check: (item, prefix) => {
      const { value, errors } = validateException(readExceptionItem(item))
      const expired = value !== null && isExpired(value.expiresAt, now)
      return {
        identity: value ? exceptionKey(value) : null,
        errors: toErrors(prefix, errors),
        warnings: expired
          ? [{ field: `${prefix}.expiresAt`, message: `Exception for ${value.resourceId} is already expired and will not be applied.`, code: 'EXCEPTION_EXPIRED' }]
          : [],
      }
    },
  })
}
