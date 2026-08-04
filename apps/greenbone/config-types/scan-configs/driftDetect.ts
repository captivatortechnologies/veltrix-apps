import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetConfigsCommand, parseConfigs } from '../../lib/gmp/scanConfigs'
import { buildScanConfigItem, findConfigByName } from './_shared'

/**
 * Drift for scan configs: compare the comment we declare against the live
 * config in gvmd. Best-effort — a config that can't be matched is skipped.
 * Read-only: <get_configs usage_type="scan"/>. GMP over TLS 9390.
 *
 * FLAG: family/NVT selection and scanner preferences are NOT compared — the
 * live get_configs response represents them in a much richer nested shape
 * than the declared JSON (see lib/gmp/scanConfigs.ts's FLAGS), so a
 * discrepancy there is never surfaced as drift. Every deploy unconditionally
 * re-applies the declared JSON regardless, so the config cannot silently
 * diverge — drift just cannot independently CONFIRM the selection matches.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential || !credential.username || !credential.password) return { hasDrift: false, diffs }

  let live
  try {
    live = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => parseConfigs(await session.send(buildGetConfigsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read configs, no drift asserted
  }

  for (const item of items) {
    const built = buildScanConfigItem(item.fields)
    const match = findConfigByName(live, built.name)
    if (!match) continue

    const expectedComment = built.comment.trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${built.name}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
