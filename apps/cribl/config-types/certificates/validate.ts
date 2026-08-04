import type { PipelineContext, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { CERTIFICATE, buildCertificateRecord } from './_shared'

/**
 * Validate Certificate items — a non-empty id and `cert`. Static. A blank
 * `priv_key` is only a WARNING — Cribl requires it on create but this app
 * can't know statically whether the certificate already exists, and a blank
 * value on an EXISTING certificate intentionally leaves it unchanged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const result = validateRecords(ctx, CERTIFICATE, buildCertificateRecord)
  const warnings: ValidationWarning[] = [...result.warnings]
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  items.forEach((item, i) => {
    if (!String(item.fields.priv_key ?? '').trim()) {
      warnings.push({
        field: `items[${i}].priv_key`,
        message: 'Private Key is blank — Cribl requires one when creating a NEW certificate; an EXISTING certificate keeps its current key unchanged.',
        code: 'PRIV_KEY_BLANK',
      })
    }
  })
  return { ...result, warnings }
}
