import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import {
  findManagedSystem,
  findWorkgroupByName,
  listFrom,
  str,
  toBool,
  workgroupIdOf,
  type ManagedSystem,
  type WorkgroupRef,
} from './_shared'

/**
 * Drift for managed systems: compare what we declare against the live system in
 * Password Safe, scoped to the resolved workgroup. A declared system that is
 * MISSING is a warning; a present system whose description / contact email /
 * auto-management flag differ is info (no confirmed update endpoint, so these
 * can only be corrected by delete + recreate — and delete itself is
 * unconfirmed, see rollback.ts). Best-effort and read-only: GET /Workgroups and
 * GET /ManagedSystems inside a PS-Auth session. Verify against a live
 * BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let workgroups: WorkgroupRef[]
  let liveSystems: ManagedSystem[]
  try {
    ;[workgroups, liveSystems] = await withSession(base, credential, async (cookie) => [
      listFrom<WorkgroupRef>(await getJson<unknown>(base, '/Workgroups', cookie)),
      listFrom<ManagedSystem>(await getJson<unknown>(base, '/ManagedSystems', cookie)),
    ])
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
  }

  for (const item of items) {
    const workgroupName = str(item.fields.workgroupName)
    const systemName = str(item.fields.systemName)
    if (!workgroupName || !systemName) continue

    const label = `${workgroupName}/${systemName}`
    const workgroup = findWorkgroupByName(workgroups, workgroupName)
    if (!workgroup) {
      diffs.push({ field: label, expected: 'present', actual: 'workgroup missing', severity: 'warning' })
      continue
    }
    const workgroupId = workgroupIdOf(workgroup)
    if (workgroupId == null) continue

    const match = findManagedSystem(liveSystems, workgroupId, systemName)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desiredDescription = str(item.fields.description)
    if (desiredDescription && str(match.Description) !== desiredDescription) {
      diffs.push({ field: `${label}.description`, expected: desiredDescription, actual: match.Description ?? '', severity: 'info' })
    }

    const desiredContactEmail = str(item.fields.contactEmail)
    if (desiredContactEmail && str(match.ContactEmail) !== desiredContactEmail) {
      diffs.push({ field: `${label}.contactEmail`, expected: desiredContactEmail, actual: match.ContactEmail ?? '', severity: 'info' })
    }

    if (typeof match.AutoManagementFlag === 'boolean') {
      const desiredAuto = toBool(item.fields.autoManagementFlag, true)
      if (match.AutoManagementFlag !== desiredAuto) {
        diffs.push({ field: `${label}.autoManagementFlag`, expected: String(desiredAuto), actual: String(match.AutoManagementFlag), severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
