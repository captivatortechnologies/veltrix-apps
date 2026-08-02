import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, getJsonOrNull } from '../../lib/authentikApi'
import { readManagedFields, sameManagedFields, snapshotManagedFields, type AuthentikApplication, type ManagedApplicationFields } from './_shared'

/**
 * Drift for authentik applications: re-fetch each declared item by slug and
 * compare the managed fields (name, provider, meta_description, meta_publisher,
 * group, policy_engine_mode) against the live application. A missing
 * application is critical drift; a changed field is a warning. Best-effort — a
 * transport error on one item skips it rather than asserting false drift.
 * Read-only: GET /core/applications/{slug}/ per item.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  for (const item of items) {
    const slug = String(item.fields.slug ?? '').trim()
    if (!slug) continue

    let live: AuthentikApplication | null
    try {
      live = await getJsonOrNull<AuthentikApplication>(`${base}/core/applications/${encodeURIComponent(slug)}/`, token, { verifyTls })
    } catch {
      continue // best-effort: can't read this item, don't assert drift
    }

    if (!live) {
      diffs.push({ field: slug, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live)
    if (sameManagedFields(expected, actual)) continue

    const fieldKeys: Array<keyof ManagedApplicationFields> = [
      'name',
      'provider',
      'meta_description',
      'meta_publisher',
      'group',
      'policy_engine_mode',
    ]
    for (const key of fieldKeys) {
      if (expected[key] !== actual[key]) {
        diffs.push({ field: `${slug}.${key}`, expected: expected[key], actual: actual[key], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
