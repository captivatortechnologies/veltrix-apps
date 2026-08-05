import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'
import { soarGetStatus } from '../../lib/soarRecordEntities'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return soarGetStatus(ctx)
}
