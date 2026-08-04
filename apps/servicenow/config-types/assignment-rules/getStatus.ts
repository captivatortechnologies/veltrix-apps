import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { configStatus } from '../../lib/tableConfig'

/** Deployment status for an assignment-rules configuration, from platform records. */
export default function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return configStatus(ctx, ['servicenow-instance'])
}
