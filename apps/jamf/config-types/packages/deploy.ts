import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { listCategories } from '../categories/deploy'
import { categoryKey, indexCategoriesByName } from '../categories/validate'
import { buildPackageBody, extractPackageSpecs, packageKey, indexPackagesByName, type LivePackage } from './validate'

const PACKAGES_PATH = '/v1/packages'

export interface PackageRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior package state, captured for a package that already existed (restored on rollback). */
  prior?: LivePackage
}

interface CreatePackageResponse {
  id?: string
}

/**
 * Deploy Jamf Pro package metadata records via the modern Jamf Pro API
 * (https://developer.jamf.com/jamf-pro/reference/get_v1-packages,
 * post_v1-packages, put_v1-packages-id). Identity is the package `name`
 * (packageName). `category_name` is resolved to a live `categoryId` via this
 * app's own Categories listing (see validate.ts header) — a category that
 * does not resolve fails that package's deploy with a clear error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractPackageSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PackageRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const [existing, categories] = await Promise.all([
      listPackages(client, ctx.settings),
      listCategories(client, ctx.settings),
    ])
    const byName = indexPackagesByName(existing)
    const categoryByName = indexCategoriesByName(categories)

    for (const spec of specs) {
      const label = spec.name
      const key = packageKey(spec.name)
      const live = byName.get(key)

      const category = categoryByName.get(categoryKey(spec.categoryName))
      if (!category?.id) {
        throw new Error(`Referenced category "${spec.categoryName}" was not found in Jamf Pro`)
      }
      const body = buildPackageBody(spec, category.id)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${PACKAGES_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update package "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreatePackageResponse>('POST', PACKAGES_PATH, body)
        if (res.error) throw new Error(`Failed to create package "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Package "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message:
        `Reconciled ${specs.length} Jamf Pro package(s) on ${apiBase}: ` +
        `${created.length} created, ${updated.length} updated. Binary upload is not managed by this app.`,
      artifacts: { apiBase, createdPackages: created, updatedPackages: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Package deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdPackages: created, updatedPackages: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

export async function listPackages(client: JamfClient, settings: Record<string, unknown>): Promise<LivePackage[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LivePackage>(PACKAGES_PATH, pageSize, 'packageName')
  if (res.error) throw new Error(`Failed to list Jamf Pro packages: ${res.error}`)
  return res.nodes
}
