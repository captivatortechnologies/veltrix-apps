import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runRuleDriftDetect } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return runRuleDriftDetect(ctx, {
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
