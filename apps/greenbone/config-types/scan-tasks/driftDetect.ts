import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetTasksCommand, parseTasks } from '../../lib/greenboneApi'
import { buildTaskFields, findTaskByName } from './_shared'

/**
 * Drift for scan tasks: compare the target / scan config / scanner / schedule and
 * comment we declare against the live task in gvmd. The task response nests each
 * foreign key as `<target id><name></target>`, so a declared value drifts when it
 * matches neither the live NAME nor the live id (the canvas accepts either form).
 * Best-effort — a task that can't be matched is skipped. Read-only: <get_tasks/>.
 * GMP over TLS 9390.
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
      async (session) => parseTasks(await session.send(buildGetTasksCommand())),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tasks, no drift asserted
  }

  const matchesRef = (declared: string, name: string, id: string) => {
    const d = declared.trim()
    return d === name.trim() || d === id
  }

  for (const item of items) {
    const fields = buildTaskFields(item.fields)
    const match = findTaskByName(live, fields.name)
    if (!match) continue
    const label = fields.name

    if (fields.target && !matchesRef(fields.target, match.targetName, match.targetId)) {
      diffs.push({ field: `${label}.target`, expected: fields.target, actual: match.targetName || match.targetId, severity: 'warning' })
    }
    if (fields.config && !matchesRef(fields.config, match.configName, match.configId)) {
      diffs.push({ field: `${label}.config`, expected: fields.config, actual: match.configName || match.configId, severity: 'warning' })
    }
    if (fields.scanner && !matchesRef(fields.scanner, match.scannerName, match.scannerId)) {
      diffs.push({ field: `${label}.scanner`, expected: fields.scanner, actual: match.scannerName || match.scannerId, severity: 'warning' })
    }
    if (fields.schedule && !matchesRef(fields.schedule, match.scheduleName, match.scheduleId)) {
      diffs.push({ field: `${label}.schedule`, expected: fields.schedule, actual: match.scheduleName || match.scheduleId, severity: 'info' })
    }

    const expectedComment = (fields.comment ?? '').trim()
    if (expectedComment && expectedComment !== match.comment.trim()) {
      diffs.push({ field: `${label}.comment`, expected: expectedComment, actual: match.comment, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
