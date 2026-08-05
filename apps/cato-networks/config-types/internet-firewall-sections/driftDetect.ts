import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runSectionDriftDetect } from '../lib/catoSectionPipeline'
import { extractSectionSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return runSectionDriftDetect(ctx, {
    policyArea: 'internetFirewall',
    typeLabel: 'Internet Firewall section',
    extractSpecs: extractSectionSpecs,
  })
}
