import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployEntities } from '../../lib/criblSystemEntities'
import { NOTIFICATION_TARGET } from './_shared'

/** Deploy Cribl Notification Targets (upsert by id) over /api/v1/notification-targets. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployEntities(ctx, NOTIFICATION_TARGET)
}
