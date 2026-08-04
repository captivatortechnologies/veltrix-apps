import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type OutboundNatMode } from '../../lib/pfsenseApi'
import { extractSpecs } from './_shared'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const spec = extractSpecs(ctx.canvas)[0]
  if (!spec?.mode) return { success: false, message: 'Declare exactly one valid outbound NAT mode.' }
  if (!hasUsableCredential(ctx.credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const built = buildPfsenseClient(ctx.component, ctx.connectivity, ctx.credential, readPfsenseSettings(ctx.settings), ctx.connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const auth = await built.client.authenticate()
  if (auth.error) return { success: false, message: auth.error }
  try {
    const previousMode = await built.client.getOutboundNatMode()
    if (previousMode !== spec.mode) {
      await built.client.updateOutboundNatMode(spec.mode)
      await built.client.applyChanges()
    }
    return {
      success: true,
      message: previousMode === spec.mode
        ? `pfSense outbound NAT mode on ${built.host} is already ${spec.mode}.`
        : `Changed pfSense outbound NAT mode on ${built.host} from ${previousMode} to ${spec.mode}.`,
      artifacts: { host: built.host, mode: spec.mode, changed: previousMode !== spec.mode },
      rollbackData: { previousMode },
    }
  } catch (error) {
    return { success: false, message: `Outbound NAT mode deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

export interface OutboundNatModeRollbackData { previousMode?: OutboundNatMode }
