import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runRuleDriftDetect } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return runRuleDriftDetect(ctx, {
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
