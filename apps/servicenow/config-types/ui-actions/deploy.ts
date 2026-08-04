import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Upsert UI actions (sys_ui_action) by (name, table) over the Table API. */
export default function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployTable(ctx, spec)
}
