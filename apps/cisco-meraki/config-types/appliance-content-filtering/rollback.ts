import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rollbackSingleton } from '../../lib/merakiSingleton'
import { transport } from './_shared'
export default (ctx: RollbackContext): Promise<RollbackResult> => rollbackSingleton(ctx, transport)

