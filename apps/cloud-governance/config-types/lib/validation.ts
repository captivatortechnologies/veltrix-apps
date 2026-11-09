import type { CanvasItemSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { itemsOf } from './readers'
import { validationResult } from './results'

export interface ItemCheck {
  /** Stable identity used to flag duplicates; null skips the duplicate check. */
  identity: string | null
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface ItemValidatorOptions {
  label: string
  duplicateMessage: (identity: string) => string
  check: (item: CanvasItemSnapshot, prefix: string) => ItemCheck
}

export function validateItems(ctx: PipelineContext, options: ItemValidatorOptions): ValidationResult {
  const items = itemsOf(ctx.canvas)
  if (items.length === 0) {
    return validationResult([{ field: 'items', message: `Add at least one ${options.label}.`, code: 'EMPTY' }], [])
  }
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const seen = new Set<string>()
  items.forEach((item, index) => {
    const prefix = `items[${index}]`
    const result = options.check(item, prefix)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
    if (result.identity === null) return
    if (seen.has(result.identity)) {
      errors.push({ field: prefix, message: options.duplicateMessage(result.identity), code: 'DUPLICATE_ITEM' })
    }
    seen.add(result.identity)
  })
  return validationResult(errors, warnings)
}
