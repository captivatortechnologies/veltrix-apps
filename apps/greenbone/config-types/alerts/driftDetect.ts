import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetAlertsCommand, parseAlerts } from '../../lib/gmp/alerts'
import { buildAlertInput, findAlertByName } from './_shared'

/**
 * Drift for alerts: compare the event/condition/method NAMES (not their data
 * sub-fields — comparing every method-specific data key reliably would need
 * per-method field maps beyond what's declared here) and comment we declare
 * against the live alert in gvmd. Best-effort — an alert that can't be matched
 * is skipped. Read-only: <get_alerts/>. GMP over TLS 9390.
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
      async (session) => parseAlerts(await session.send(buildGetAlertsCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read alerts, no drift asserted
  }

  for (const item of items) {
    const input = buildAlertInput(item.fields)
    const match = findAlertByName(live, input.name)
    if (!match) continue
    const label = input.name

    if (input.event.value !== match.event.value) diffs.push({ field: `${label}.event`, expected: input.event.value, actual: match.event.value, severity: 'warning' })
    if (input.condition.value !== match.condition.value) diffs.push({ field: `${label}.condition`, expected: input.condition.value, actual: match.condition.value, severity: 'warning' })
    if (input.method.value !== match.method.value) diffs.push({ field: `${label}.method`, expected: input.method.value, actual: match.method.value, severity: 'warning' })

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
