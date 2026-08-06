import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { createPackage, getPackageDetails, updatePackage, type GzPackageBody } from '../../lib/gravityZoneApi'
import {
  buildPackageBody,
  extractInstallationPackageSpecs,
  findLivePackage,
  listAllPackages,
  livePackageId,
  packageFieldsMatch,
  parsePackageJsonFields,
} from './_shared'

export interface InstallationPackageRollbackEntry {
  packageName: string
  action: 'created' | 'updated' | 'unchanged'
  newId?: string
  prior?: GzPackageBody
}

/**
 * Deploy GravityZone installation packages, reconciled by packageName:
 *   create: packages.createPackage    when no live package has this name
 *   update: packages.updatePackage    when the package exists but a declared field differs
 *   no-op:  nothing                    when the live package (full detail) already matches
 *
 * The list is a summary — packages.getPackageDetails is fetched for every
 * matched package so the JSON sub-objects are compared against the FULL
 * live object, not the list item.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractInstallationPackageSpecs(ctx.canvas).filter((s) => s.packageName)
  const previous: InstallationPackageRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listAllPackages(client)

    for (const spec of specs) {
      const parsed = parsePackageJsonFields(spec)
      const body = buildPackageBody(spec, parsed)
      const match = findLivePackage(live, spec.packageName)

      if (!match) {
        const created = await createPackage(client, body)
        previous.push({ packageName: spec.packageName, action: 'created', newId: created.id })
        live.push({ id: created.id, packageName: spec.packageName })
      } else {
        const id = livePackageId(match)
        const full = (await getPackageDetails(client, id)) ?? match
        if (packageFieldsMatch(spec, parsed, full)) {
          previous.push({ packageName: spec.packageName, action: 'unchanged' })
        } else {
          previous.push({
            packageName: spec.packageName,
            action: 'updated',
            prior: {
              packageName: full.packageName ?? spec.packageName,
              description: full.description,
              language: full.language,
              productType: full.productType,
              modules: full.modules,
              scanMode: full.scanMode,
              settings: full.settings,
              roles: full.roles,
              deploymentOptions: full.deploymentOptions,
            },
          })
          await updatePackage(client, id, body)
        }
      }
      deployed.push(spec.packageName)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} installation package(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Installation package deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
