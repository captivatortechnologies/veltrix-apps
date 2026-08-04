import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type Sgacl } from '../../lib/iseApi'
import { extractSpecs, normalizeAclContent } from './_shared'

/**
 * Drift for SGACLs: a declared ACL missing from ISE is critical drift; a
 * description, IP version or content mismatch is a warning. Read-only.
 * Best-effort — an ACL that can't be read is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<Sgacl>(base, 'sgacl', 'Sgacl', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.name) continue

    let existing
    try {
      existing = await client.findByName(spec.name)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedDescription = spec.description
    const actualDescription = String(live.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    if (spec.ipVersion !== (live.ipVersion ?? '')) {
      diffs.push({ field: `${spec.name}.ip_version`, expected: spec.ipVersion, actual: live.ipVersion ?? '', severity: 'warning' })
    }

    const expectedContent = spec.aclContent
    const actualContent = normalizeAclContent(live.aclcontent)
    if (expectedContent !== actualContent) {
      diffs.push({ field: `${spec.name}.acl_content`, expected: expectedContent, actual: actualContent, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
