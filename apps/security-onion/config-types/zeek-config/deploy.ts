// =============================================================================
// REPRESENTATIVE mapping. Deep Zeek configuration on Security Onion is
// Salt-pillar / file-based (policy scripts, `local.zeek`, per-log tuning). This
// config type toggles Zeek log types / analyzers on/off via a declared command
// (so-zeek-logs) and MUST be verified against a live grid before relying on it.
// Writing full pillar files needs stdin support on the remote executor, which is
// a documented follow-up — until then this covers the common enable/disable case.
// =============================================================================
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const applied: Array<{ logType: string; action: string }> = []

  try {
    for (const item of items) {
      const logType = String(item.fields.logType ?? '').trim()
      const action = String(item.fields.action ?? 'enable')
      if (!logType) continue
      await soCommand(ctx.remote, SO_CMD.zeekToggle, { action, logtype: logType })
      applied.push({ logType, action })
    }

    if (applied.length > 0) await applyHighstate(ctx.remote)

    return {
      success: true,
      message: `Applied ${applied.length} Zeek log-type state(s): ${applied.map((a) => `${a.logType}=${a.action}`).join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  } catch (error) {
    return {
      success: false,
      message: `Zeek config deploy failed after ${applied.length} log type(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  }
}
