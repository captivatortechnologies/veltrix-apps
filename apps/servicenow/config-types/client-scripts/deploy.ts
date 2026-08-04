import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Upsert client scripts (sys_script_client) by (name, table, type) over the Table API. */
export default function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployTable(ctx, spec)
}
