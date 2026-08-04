import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { resolveConfigStatus } from '../../lib/status'

/** Deployment status for an authentication-flows configuration, from platform records. */
export default function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return resolveConfigStatus(ctx)
}
