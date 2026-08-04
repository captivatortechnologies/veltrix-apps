import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { toTeamId, toFilename, findScriptByFilename, downloadScriptContent } from './_shared'

/**
 * Drift for scripts: for each declared script, compare its content against the
 * live script content in Fleet. Best-effort — a script that can't be read
 * (missing / transient error) is skipped rather than raising false drift. Like
 * queries/labels/policies, this only checks DECLARED scripts — a script added
 * to Fleet outside this canvas is not flagged as unexpected.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    const teamId = toTeamId(item.fields.teamId)
    const filename = toFilename(name, item.fields.scriptType)
    const expectedContent = String(item.fields.scriptContent ?? '')

    const live = await findScriptByFilename(base, headers, teamId, filename)
    if (!live) {
      diffs.push({ field: `${filename}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const liveContent = await downloadScriptContent(base, headers, live.id)
    if (liveContent === null) continue // best-effort: skip a script we can't download

    if (liveContent !== expectedContent) {
      diffs.push({ field: `${filename}.content`, expected: expectedContent, actual: liveContent, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
