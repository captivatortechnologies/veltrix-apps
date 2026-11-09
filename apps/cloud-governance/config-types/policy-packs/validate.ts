import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validatePack } from '../../lib/model'
import { readPackItem } from '../lib/packItem'
import { toErrors } from '../lib/results'
import { validateItems } from '../lib/validation'

/**
 * Shape only: pack name and a non-empty, de-duplicated member list. Whether the
 * members exist needs the governance store, which validate does not have; deploy
 * checks that and refuses a pack with a missing member.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateItems(ctx, {
    label: 'policy pack',
    duplicateMessage: (name) => `Pack "${name}" is declared more than once.`,
    check: (item, prefix) => {
      const pack = readPackItem(item)
      const { errors } = validatePack(pack)
      return {
        identity: typeof pack.name === 'string' && pack.name !== '' ? pack.name : null,
        errors: toErrors(prefix, errors),
        warnings: [],
      }
    },
  })
}
