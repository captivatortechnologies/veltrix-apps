import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { gzGetStatus } from '../../lib/gravityZoneCommon'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return gzGetStatus(ctx)
}
