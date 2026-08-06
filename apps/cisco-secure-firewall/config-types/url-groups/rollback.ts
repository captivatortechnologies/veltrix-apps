import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRollback } from '../../lib/fmcPipeline'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRollback(ctx, 'URL group(s)')
}
