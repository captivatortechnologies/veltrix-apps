import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { configDeploymentStatus } from '../../lib/status'

/** Deployment status for a scan-configs configuration, from platform records. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return configDeploymentStatus(ctx)
}
