import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo a virtual-ips deploy from rollbackData.previous (written by
 * deploy()): for each entry, PATCH the prior fields back (restore), or —
 * when the VIP was newly created (prior detail null) — DELETE it. Pending
 * changes are applied ONCE at the end via the virtual-IP-specific
 * /api/v2/firewall/virtual_ip/apply (SEPARATE from the shared
 * /api/v2/firewall/apply — see deploy.ts's module doc).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.prior) {
        await client.updateVirtualIp(entry.id, { ...entry.prior, subnet: entry.subnet })
        restored++
      } else {
        await client.deleteVirtualIp(entry.id)
        deleted++
      }
    }

    if (restored > 0 || deleted > 0) {
      await client.applyVirtualIpChanges()
    }

    return {
      success: true,
      message: `Rolled back pfSense virtual IPs: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
