import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { sophosGetStatus } from '../../lib/sophosCommon'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return sophosGetStatus(ctx)
}
