import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { taniumConfigStatus } from '../../lib/taniumStatus'

/** Deployment status for a saved-questions configuration, from platform records. */
export default function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return taniumConfigStatus(ctx)
}
