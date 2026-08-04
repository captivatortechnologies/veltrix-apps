import type { PipelineContext, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { SECRET, buildSecretRecord } from './_shared'

/**
 * Validate Secret items — a non-empty id and a recognized secret_type. Static.
 * The secret material itself being blank is only a WARNING — Cribl requires it
 * on create but this app can't know statically whether the secret already
 * exists, and a blank value on an EXISTING secret intentionally leaves it
 * unchanged (see _shared.ts).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const result = validateRecords(ctx, SECRET, buildSecretRecord)
  const warnings: ValidationWarning[] = [...result.warnings]
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  items.forEach((item, i) => {
    const f = item.fields
    const secretType = String(f.secret_type ?? '').trim()
    const hasMaterial =
      (secretType === 'text' && String(f.value ?? '').trim()) ||
      (secretType === 'credentials' && String(f.username ?? '').trim() && String(f.password ?? '').trim()) ||
      (secretType === 'keypair' && String(f.api_key ?? '').trim() && String(f.secret_key ?? '').trim())
    if (secretType && !hasMaterial) {
      warnings.push({
        field: `items[${i}]`,
        message: `Secret material is blank — Cribl requires it when creating a NEW ${secretType} secret; an EXISTING secret keeps its current value unchanged.`,
        code: 'SECRET_BLANK',
      })
    }
  })
  return { ...result, warnings }
}
