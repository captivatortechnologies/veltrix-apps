import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runRuleDriftDetect } from '../lib/catoRulePipeline'
import { buildRuleData, extractRuleSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return runRuleDriftDetect(ctx, {
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
