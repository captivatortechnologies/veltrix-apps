import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRuleRollback } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRuleRollback(ctx, {
    policyArea: 'tlsInspect',
    typeLabel: 'TLS Inspection rule',
    addInputType: 'TlsInspectAddRuleInput!',
    updateInputType: 'TlsInspectUpdateRuleInput!',
    removeInputType: 'TlsInspectRemoveRuleInput!',
    extractSpecs: extractRuleSpecs,
    buildAddData: buildRuleData,
    buildUpdateData: buildRuleData,
  })
}
