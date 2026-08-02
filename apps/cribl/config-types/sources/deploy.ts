import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployEntities } from '../../lib/criblSystemEntities'
import { SOURCE } from './_shared'

/** Deploy Cribl Sources (upsert by id) over /api/v1/m/<group>/system/inputs. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployEntities(ctx, SOURCE)
}
