import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { criblGetStatus } from '../../lib/criblCommon'

/** Deployment status for an Event Breaker Rulesets configuration, from platform records. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return criblGetStatus(ctx)
}
