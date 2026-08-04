import type { PipelineContext, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { DATABASE_CONNECTION, buildDatabaseConnectionRecord } from './_shared'

/**
 * Validate Database Connection items — required identity/type/description
 * fields (see _shared.ts). Static. Adds a warning when NO credential
 * mechanism is set at all (a fresh connection needs one of connection_string,
 * password+user, creds_secrets or text_secret; a blank credential field alone
 * is otherwise valid — see the write-only-secret note in _shared.ts).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const result = validateRecords(ctx, DATABASE_CONNECTION, buildDatabaseConnectionRecord)
  const warnings: ValidationWarning[] = [...result.warnings]
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  items.forEach((item, i) => {
    const f = item.fields
    const hasCredential = [f.connection_string, f.password, f.creds_secrets, f.text_secret].some((v) => String(v ?? '').trim())
    if (!hasCredential) {
      warnings.push({
        field: `items[${i}]`,
        message: 'No credential is set (connection_string, password, creds_secrets or text_secret) — required by Cribl when creating a NEW connection; an EXISTING connection keeps its current credential unchanged.',
        code: 'NO_CREDENTIAL',
      })
    }
  })
  return { ...result, warnings }
}
