import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRollback } from '../../lib/pipeline'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRollback(ctx, 'security rule(s)')
}
