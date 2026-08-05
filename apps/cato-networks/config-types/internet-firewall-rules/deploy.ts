import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runRuleDeploy } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runRuleDeploy(ctx, {
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
