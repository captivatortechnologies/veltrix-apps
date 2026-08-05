import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { runRuleRollback } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  return runRuleRollback(ctx, {
    policyArea: 'wanFirewall',
    typeLabel: 'WAN Firewall rule',
    addInputType: 'WanFirewallAddRuleInput!',
    updateInputType: 'WanFirewallUpdateRuleInput!',
    removeInputType: 'WanFirewallRemoveRuleInput!',
    extractSpecs: extractRuleSpecs,
    buildAddData: buildRuleData,
    buildUpdateData: buildRuleData,
  })
}
