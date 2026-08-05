import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runSectionDeploy } from '../lib/catoSectionPipeline'
import { extractSectionSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runSectionDeploy(ctx, {
    policyArea: 'wanFirewall',
    typeLabel: 'WAN Firewall section',
    extractSpecs: extractSectionSpecs,
  })
}
