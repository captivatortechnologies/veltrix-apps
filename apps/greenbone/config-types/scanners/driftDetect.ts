import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort } from '../../lib/greenboneApi'
import { buildGetScannersFullCommand, parseScannersFull } from '../../lib/gmp/scanners'
import { buildScannerInput, findScannerByName } from './_shared'

/**
 * Drift for scanners: compare host/port/type/credential/ca_pub/comment we
 * declare against the live scanner in gvmd. Best-effort — a scanner that
 * can't be matched is skipped. Read-only: <get_scanners/>. GMP over TLS 9390.
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
      async (session) => parseScannersFull(await session.send(buildGetScannersFullCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read scanners, no drift asserted
  }

  for (const item of items) {
    const input = buildScannerInput(item.fields)
    const match = findScannerByName(live, input.name)
    if (!match) continue
    const label = input.name

    if (input.host !== match.host) diffs.push({ field: `${label}.host`, expected: input.host, actual: match.host, severity: 'warning' })
    if (String(input.port) !== match.port) diffs.push({ field: `${label}.port`, expected: String(input.port), actual: match.port, severity: 'warning' })
    if (input.type !== match.type) diffs.push({ field: `${label}.type`, expected: input.type, actual: match.type, severity: 'warning' })
    if (input.credentialId !== match.credentialId) {
      diffs.push({ field: `${label}.credentialId`, expected: input.credentialId, actual: match.credentialId, severity: 'critical' })
    }

    const expectedComment = (input.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
