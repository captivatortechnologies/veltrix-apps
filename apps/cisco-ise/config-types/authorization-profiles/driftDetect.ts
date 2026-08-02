import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  type AuthorizationProfile,
  type AuthorizationProfileAdvancedAttribute,
} from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/** Render a VLAN assignment as a comparable string ("" when unset). */
function vlanKey(vlan: AuthorizationProfile['vlan']): string {
  if (!vlan?.nameID) return ''
  return `${vlan.nameID}:${vlan.tagID ?? 1}`
}

/** Render advanced attributes as a comparable, order-independent string. */
function attributesKey(attrs: AuthorizationProfileAdvancedAttribute[] | undefined): string {
  return (attrs ?? [])
    .map((a) => `${a.leftHandSideDictionaryAttribute ?? ''}=${a.rightHandSideAttributeValue ?? ''}`)
    .sort()
    .join('; ')
}

/**
 * Drift for authorization profiles: a declared profile missing from ISE is
 * critical drift; a mismatch in access type, ACL/DACL, VLAN or advanced
 * attributes is a warning. Read-only. Best-effort — a profile that can't be
 * read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<AuthorizationProfile>(base, 'authorizationprofile', 'AuthorizationProfile', credential, settings)

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

    if (spec.accessType !== (live.accessType ?? '')) {
      diffs.push({ field: `${spec.name}.access_type`, expected: spec.accessType, actual: live.accessType ?? '', severity: 'warning' })
    }

    if (spec.acl !== (live.acl ?? '')) {
      diffs.push({ field: `${spec.name}.acl`, expected: spec.acl, actual: live.acl ?? '', severity: 'warning' })
    }

    if (spec.daclName !== (live.daclName ?? '')) {
      diffs.push({ field: `${spec.name}.dacl_name`, expected: spec.daclName, actual: live.daclName ?? '', severity: 'warning' })
    }

    if (spec.airespaceAcl !== (live.airespaceACL ?? '')) {
      diffs.push({ field: `${spec.name}.airespace_acl`, expected: spec.airespaceAcl, actual: live.airespaceACL ?? '', severity: 'warning' })
    }

    const expectedVlan = spec.vlanName ? `${spec.vlanName}:${spec.vlanTag ?? 1}` : ''
    const actualVlan = vlanKey(live.vlan)
    if (expectedVlan !== actualVlan) {
      diffs.push({ field: `${spec.name}.vlan`, expected: expectedVlan, actual: actualVlan, severity: 'warning' })
    }

    const expectedAttrs = attributesKey(spec.advancedAttributes)
    const actualAttrs = attributesKey(live.advancedAttributes)
    if (expectedAttrs !== actualAttrs) {
      diffs.push({ field: `${spec.name}.advanced_attributes`, expected: expectedAttrs, actual: actualAttrs, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
