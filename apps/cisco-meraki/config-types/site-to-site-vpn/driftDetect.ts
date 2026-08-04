import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftSingleton } from '../../lib/merakiSingleton'
import { transport } from './_shared'
export default (ctx: DriftContext): Promise<DriftResult> => driftSingleton(ctx, transport)

