import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runRuleDriftDetect } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return runRuleDriftDetect(ctx, {
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
