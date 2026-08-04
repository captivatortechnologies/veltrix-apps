import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import {
  findDirectory,
  findWorkgroupByName,
  listFrom,
  projectFromFields,
  projectFromLive,
  str,
  workgroupIdOf,
  type Directory,
  type WorkgroupRef,
} from './_shared'

/**
 * Drift for directories: compare what we declare against the live directory in
 * BeyondInsight, scoped to the resolved workgroup. A declared directory that is
 * MISSING (or whose workgroup is missing) is a warning; a present directory
 * whose forest / NetBIOS name / port / SSL / timeout / description / contact
 * email / password rule differ is ALSO a warning — PUT /Directories/{id}
 * exists, so this drift is correctable by a redeploy. Best-effort and
 * read-only: GET /Workgroups and GET /Directories inside a PS-Auth session.
 * Verify against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let workgroups: WorkgroupRef[]
  let liveDirectories: Directory[]
  try {
    ;[workgroups, liveDirectories] = await withSession(base, credential, async (cookie) => [
      listFrom<WorkgroupRef>(await getJson<unknown>(base, '/Workgroups', cookie)),
      listFrom<Directory>(await getJson<unknown>(base, '/Directories', cookie)),
    ])
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
  }

  for (const item of items) {
    const workgroupName = str(item.fields.workgroupName)
    const domainName = str(item.fields.domainName)
    if (!workgroupName || !domainName) continue

    const label = `${workgroupName}/${domainName}`
    const workgroup = findWorkgroupByName(workgroups, workgroupName)
    if (!workgroup) {
      diffs.push({ field: label, expected: 'present', actual: 'workgroup missing', severity: 'warning' })
      continue
    }
    const workgroupId = workgroupIdOf(workgroup)
    if (workgroupId == null) continue

    const match = findDirectory(liveDirectories, workgroupId, domainName)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    if (expected.forestName && expected.forestName !== actual.forestName) {
      diffs.push({ field: `${label}.forestName`, expected: expected.forestName, actual: actual.forestName, severity: 'warning' })
    }
    if (expected.netBiosName && expected.netBiosName !== actual.netBiosName) {
      diffs.push({ field: `${label}.netBiosName`, expected: expected.netBiosName, actual: actual.netBiosName, severity: 'warning' })
    }
    if (expected.port !== null && expected.port !== actual.port) {
      diffs.push({ field: `${label}.port`, expected: String(expected.port), actual: String(actual.port ?? ''), severity: 'warning' })
    }
    if (expected.useSSL !== actual.useSSL) {
      diffs.push({ field: `${label}.useSSL`, expected: String(expected.useSSL), actual: String(actual.useSSL), severity: 'warning' })
    }
    if (expected.timeout !== null && expected.timeout !== actual.timeout) {
      diffs.push({ field: `${label}.timeout`, expected: String(expected.timeout), actual: String(actual.timeout ?? ''), severity: 'warning' })
    }
    if (expected.description && expected.description !== actual.description) {
      diffs.push({ field: `${label}.description`, expected: expected.description, actual: actual.description, severity: 'warning' })
    }
    if (expected.contactEmail && expected.contactEmail !== actual.contactEmail) {
      diffs.push({ field: `${label}.contactEmail`, expected: expected.contactEmail, actual: actual.contactEmail, severity: 'warning' })
    }
    if (expected.passwordRuleId !== null && expected.passwordRuleId !== actual.passwordRuleId) {
      diffs.push({ field: `${label}.passwordRuleId`, expected: String(expected.passwordRuleId), actual: String(actual.passwordRuleId ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
