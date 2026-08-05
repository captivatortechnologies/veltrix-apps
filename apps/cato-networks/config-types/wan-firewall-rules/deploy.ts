import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runRuleDeploy } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runRuleDeploy(ctx, {
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
