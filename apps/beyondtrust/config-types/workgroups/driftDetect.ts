import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import { findWorkgroup, str, workgroupsFromList } from './_shared'

/**
 * Drift for workgroups: a declared workgroup that is MISSING in BeyondInsight is
 * a warning. Name is the only field a workgroup create sets (the POST body has no
 * description), so there is nothing else to compare — a present workgroup is in
 * sync. Best-effort and read-only: GET /Workgroups inside a PS-Auth session.
 * Verify against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = await withSession(base, credential, async (cookie) =>
      workgroupsFromList(await getJson<unknown>(base, '/Workgroups', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read workgroups, no drift asserted
  }

  for (const item of items) {
    const name = str(item.fields.name)
    if (!name) continue
    if (!findWorkgroup(live, name)) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
