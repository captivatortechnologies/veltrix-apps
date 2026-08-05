import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRuleRollback } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRuleRollback(ctx, {
    policyArea: 'applicationControl',
    typeLabel: 'Application Control rule',
    addInputType: 'ApplicationControlAddRuleInput!',
    updateInputType: 'ApplicationControlUpdateRuleInput!',
    removeInputType: 'ApplicationControlRemoveRuleInput!',
    extractSpecs: extractRuleSpecs,
    buildAddData: buildRuleData,
    buildUpdateData: buildRuleData,
  })
}
