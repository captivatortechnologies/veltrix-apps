import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRuleRollback } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRuleRollback(ctx, {
    policyArea: 'internetFirewall',
    typeLabel: 'Internet Firewall rule',
    addInputType: 'InternetFirewallAddRuleInput!',
    updateInputType: 'InternetFirewallUpdateRuleInput!',
    removeInputType: 'InternetFirewallRemoveRuleInput!',
    extractSpecs: extractRuleSpecs,
    buildAddData: buildRuleData,
    buildUpdateData: buildRuleData,
  })
}
