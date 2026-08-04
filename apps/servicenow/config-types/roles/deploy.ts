import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Upsert roles (sys_user_role) by name over the Table API. */
export default function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployTable(ctx, spec)
}
