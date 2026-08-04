import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { criblGetStatus } from '../../lib/criblCommon'

/** Deployment status for a Grok Pattern Files configuration, from platform records. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return criblGetStatus(ctx)
}
