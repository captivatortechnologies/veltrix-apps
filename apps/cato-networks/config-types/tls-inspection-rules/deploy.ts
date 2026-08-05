import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runRuleDeploy } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runRuleDeploy(ctx, {
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
