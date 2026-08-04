import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient } from '../../lib/hackeroneApi'
import { findProgramId, str, readPolicyFromProgram } from './_shared'

/**
 * Drift for Program Policy: for each declared program, confirm its live policy
 * text still matches what we declare (exact string compare). Read-only:
 *   GET /me/programs      → resolve handles → ids
 *   GET /programs/{id}    → live policy text
 *
 * Best-effort — a program that can't be resolved / read is reported as missing
 * rather than raising noisy false drift. HackerOne may reformat Markdown
 * whitespace on save; an exact-text compare can over-report drift in that case —
 * flagged here rather than silently normalizing text we haven't verified is safe
 * to normalize.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let programs
  try {
    const res = await client.listPrograms()
    if (!res.ok) return { hasDrift: false, diffs }
    programs = res.items
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const handle = str(item.fields.program_handle)
    if (!handle) continue

    const programId = findProgramId(programs, handle)
    if (!programId) {
      diffs.push({ field: handle, expected: 'program present', actual: 'not found', severity: 'warning' })
      continue
    }

    let live: string | null = null
    try {
      const res = await client.get(`/programs/${encodeURIComponent(programId)}`)
      if (res.ok) live = readPolicyFromProgram(res.json)
    } catch {
      continue
    }
    if (live === null) continue

    const desired = str(item.fields.policy)
    if (live !== desired) {
      diffs.push({ field: `${handle}.policy`, expected: desired, actual: live, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
