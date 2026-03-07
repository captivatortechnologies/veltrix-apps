import type { PipelineContext, ValidationResult } from '../types/pipeline'

/**
 * Define a validation handler for a configuration type.
 *
 * @example
 * ```ts
 * import { defineValidator } from '@veltrix/app-sdk/pipeline'
 *
 * export default defineValidator(async (ctx) => {
 *   const errors = []
 *   const name = ctx.canvas.sections[0]?.fields['name']
 *   if (!name) {
 *     errors.push({ field: 'name', message: 'Name is required', code: 'REQUIRED' })
 *   }
 *   return { valid: errors.length === 0, errors, warnings: [] }
 * })
 * ```
 */
export function defineValidator(
  handler: (ctx: PipelineContext) => Promise<ValidationResult>,
): (ctx: PipelineContext) => Promise<ValidationResult> {
  return handler
}
