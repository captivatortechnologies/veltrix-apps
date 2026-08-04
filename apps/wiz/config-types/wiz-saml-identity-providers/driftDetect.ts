import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listSamlIdps, readSamlIdp } from './deploy'
import { extractSamlIdpSpecs, idpKey, type LiveSamlIdp } from './validate'

/**
 * Detect drift between the deployed SAML identity provider configuration and
 * the live tenant. Re-finds each declared provider by name and diffs the
 * managed fields: a missing provider is critical drift; a changed endpoint,
 * certificate, role-management setting or group mapping set is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSamlIdpSpecs(ctx.deployedConfig).filter((s) => s.name && s.loginUrl && s.certificate)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSamlIdps(client)
    const byName = new Map<string, LiveSamlIdp>(live.filter((p) => p.name).map((p) => [idpKey(p.name as string), p]))

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(idpKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readSamlIdp(client, found.id)

      if ((full.loginURL ?? '') !== spec.loginUrl) {
        diffs.push({ field: `${label}.login_url`, expected: spec.loginUrl, actual: full.loginURL ?? 'not set', severity: 'warning' })
      }
      if ((full.logoutURL ?? '') !== spec.logoutUrl) {
        diffs.push({ field: `${label}.logout_url`, expected: spec.logoutUrl || '(none)', actual: full.logoutURL || '(none)', severity: 'warning' })
      }
      if ((full.certificate ?? '').trim() !== spec.certificate.trim()) {
        diffs.push({ field: `${label}.certificate`, expected: 'as declared', actual: 'changed in Wiz', severity: 'warning' })
      }
      const liveManaged = full.useProviderManagedRoles ?? false
      if (liveManaged !== spec.useProviderManagedRoles) {
        diffs.push({
          field: `${label}.use_provider_managed_roles`,
          expected: String(spec.useProviderManagedRoles),
          actual: String(liveManaged),
          severity: 'warning',
        })
      }
      const liveOverride = full.allowManualRoleOverride ?? true
      if (liveOverride !== spec.allowManualRoleOverride) {
        diffs.push({
          field: `${label}.allow_manual_role_override`,
          expected: String(spec.allowManualRoleOverride),
          actual: String(liveOverride),
          severity: 'warning',
        })
      }

      const declaredMappings = (spec.groupMapping ?? []).length
      const liveMappings = (full.groupMapping ?? []).length
      if (declaredMappings !== liveMappings) {
        diffs.push({
          field: `${label}.group_mapping`,
          expected: `${declaredMappings} mapping(s)`,
          actual: `${liveMappings} mapping(s)`,
          severity: 'warning',
        })
      }

      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
