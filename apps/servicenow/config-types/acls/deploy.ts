import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Upsert ACLs (sys_security_acl, type=record) by (name, operation) over the Table API. */
export default function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployTable(ctx, spec)
}
