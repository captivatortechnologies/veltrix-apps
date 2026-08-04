import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type AllowedProtocols,
} from '../../lib/iseApi'
import type { RollbackEntry } from './deploy'

/**
 * Undo an allowed-protocols deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior flags back (restore), or — when
 * the service was newly created (prior detail null) — DELETE it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<AllowedProtocols>(base, 'allowedprotocols', 'Allowedprotocols', credential, settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      if (entry.service) {
        const s = entry.service
        await client.update(entry.id, {
          name: s.name ?? entry.name,
          description: s.description ?? '',
          allowPapAscii: s.allowPapAscii,
          allowChap: s.allowChap,
          allowMsChapV1: s.allowMsChapV1,
          allowMsChapV2: s.allowMsChapV2,
          allowEapMd5: s.allowEapMd5,
          allowLeap: s.allowLeap,
          allowEapTls: s.allowEapTls,
          allowPeap: s.allowPeap,
          allowEapTtls: s.allowEapTtls,
          allowEapFast: s.allowEapFast,
          allowTeap: s.allowTeap,
          preferredEapProtocol: s.preferredEapProtocol,
          processHostLookup: s.processHostLookup,
        })
        restored++
      } else {
        await client.remove(entry.id)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back Allowed Protocols services: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
