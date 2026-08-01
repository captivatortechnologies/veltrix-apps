import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { getEntityByName } from '../../lib/taniumRestEntity'
import { PACKAGES_RESOURCE, packageTimeout, type TaniumPackage } from './_shared'

/**
 * Drift for packages: compare the declared command (and, when set, the command
 * timeout) against the live package in Tanium. Best-effort — a package that can't
 * be matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: GET /api/v2/packages/by-name/{name}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  let session: string
  try {
    session = await resolveTaniumSession(base, credential)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let match: TaniumPackage | null
    try {
      match = await getEntityByName<TaniumPackage>(base, session, PACKAGES_RESOURCE, name)
    } catch {
      continue
    }
    if (!match) continue

    const expectedCommand = String(item.fields.command ?? '').trim()
    const actualCommand = String(match.command ?? '').trim()
    if (expectedCommand && actualCommand !== expectedCommand) {
      diffs.push({ field: `${name}.command`, expected: expectedCommand, actual: actualCommand, severity: 'warning' })
    }

    const expectedTimeout = String(item.fields.commandTimeout ?? '').trim()
    if (expectedTimeout && /^\d+$/.test(expectedTimeout)) {
      const actualTimeout = packageTimeout(match)
      if (actualTimeout !== undefined && String(actualTimeout) !== expectedTimeout) {
        diffs.push({ field: `${name}.commandTimeout`, expected: expectedTimeout, actual: String(actualTimeout), severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
