import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getPackageDetails } from '../../lib/gravityZoneApi'
import { extractInstallationPackageSpecs, findLivePackage, listAllPackages, livePackageId, packageFieldsMatch, parsePackageJsonFields } from './_shared'

/**
 * Detect drift for installation packages: for each declared packageName,
 * find the live package (full detail via packages.getPackageDetails) and
 * compare description/language/productType/modules/scanMode/settings/roles/
 * deploymentOptions. A missing package is critical drift; a changed field is
 * a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractInstallationPackageSpecs(ctx.deployedConfig).filter((s) => s.packageName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listAllPackages(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  for (const spec of specs) {
    const match = findLivePackage(live, spec.packageName)
    if (!match) {
      diffs.push({ field: spec.packageName, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const full = (await getPackageDetails(client, livePackageId(match))) ?? match
    const parsed = parsePackageJsonFields(spec)
    if (!packageFieldsMatch(spec, parsed, full)) {
      diffs.push({
        field: `${spec.packageName}.configuration`,
        expected: {
          description: spec.description,
          language: spec.language,
          productType: spec.productType ?? 0,
          modules: parsed.modules ?? {},
          scanMode: parsed.scanMode ?? {},
          settings: parsed.settings ?? {},
          roles: parsed.roles ?? {},
          deploymentOptions: parsed.deploymentOptions ?? {},
        },
        actual: {
          description: full.description ?? '',
          language: full.language ?? '',
          productType: full.productType ?? 0,
          modules: full.modules ?? {},
          scanMode: full.scanMode ?? {},
          settings: full.settings ?? {},
          roles: full.roles ?? {},
          deploymentOptions: full.deploymentOptions ?? {},
        },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
