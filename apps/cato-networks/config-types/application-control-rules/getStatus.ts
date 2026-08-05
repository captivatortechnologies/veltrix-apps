import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { runGetStatus } from '../lib/catoPolicy'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  return runGetStatus(ctx)
}
