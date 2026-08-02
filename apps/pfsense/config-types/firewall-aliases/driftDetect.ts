import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { aliasKey, extractSpecs } from './_shared'

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/**
 * Detect drift between the last-deployed firewall-alias configuration
 * (`ctx.deployedConfig` — what was actually applied, not the current
 * in-progress canvas draft) and live pfSense state. A missing alias, a type
 * change or an address-set change is CRITICAL (each changes what traffic the
 * alias matches); a description or detail-text mismatch is a WARNING.
 * Read-only — makes no writes and never calls /firewall/apply.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listAliases()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byName = new Map(live.filter((a) => a.name).map((a) => [aliasKey(a.name), a]))

  for (const spec of specs) {
    const found = byName.get(aliasKey(spec.name))
    const label = spec.name

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (found.type !== spec.type) {
      diffs.push({ field: `${label}.type`, expected: spec.type, actual: found.type, severity: 'critical' })
    }

    const liveAddress = Array.isArray(found.address) ? found.address : []
    if (!sameStringList(liveAddress, spec.address)) {
      diffs.push({
        field: `${label}.address`,
        expected: spec.address.join(', ') || '(none)',
        actual: liveAddress.join(', ') || '(none)',
        severity: 'critical',
      })
    }

    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) {
      diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
    }

    const liveDetail = Array.isArray(found.detail) ? found.detail : []
    if (spec.detail.length > 0 && !sameStringList(liveDetail, spec.detail)) {
      diffs.push({
        field: `${label}.detail`,
        expected: spec.detail.join(' || ') || '(none)',
        actual: liveDetail.join(' || ') || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
