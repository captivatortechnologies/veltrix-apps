import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { DATABASE_CONNECTION, buildDatabaseConnectionRecord } from './_shared'

/**
 * Detect drift between declared Database Connections and the live entries in
 * Cribl. Credential fields are never compared (write-only, see _shared.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, DATABASE_CONNECTION, buildDatabaseConnectionRecord)
}
