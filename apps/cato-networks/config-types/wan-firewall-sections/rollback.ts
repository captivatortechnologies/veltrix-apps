import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runSectionRollback } from '../lib/catoSectionPipeline'
import { extractSectionSpecs } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runSectionRollback(ctx, {
    policyArea: 'wanFirewall',
    typeLabel: 'WAN Firewall section',
    extractSpecs: extractSectionSpecs,
  })
}
