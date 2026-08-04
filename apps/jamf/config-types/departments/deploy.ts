import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { buildDepartmentBody, departmentKey, extractDepartmentSpecs, indexDepartmentsByName, type LiveDepartment } from './validate'

const DEPARTMENTS_PATH = '/v1/departments'

export interface DepartmentRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveDepartment
}

interface CreateDepartmentResponse {
  id?: string
}

/**
 * Deploy Jamf Pro departments via the modern Jamf Pro API
 * (https://developer.jamf.com/jamf-pro/reference/get_v1-departments,
 * post_v1-departments, put_v1-departments-id). Identity is the department
 * `name`: list, match, create missing / update existing (capturing prior
 * state for rollback).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractDepartmentSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DepartmentRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listDepartments(client, ctx.settings)
    const byName = indexDepartmentsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = departmentKey(spec.name)
      const live = byName.get(key)
      const body = buildDepartmentBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${DEPARTMENTS_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update department "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateDepartmentResponse>('POST', DEPARTMENTS_PATH, body)
        if (res.error) throw new Error(`Failed to create department "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Department "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Jamf Pro department(s) on ${apiBase}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { apiBase, createdDepartments: created, updatedDepartments: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Department deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdDepartments: created, updatedDepartments: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

export async function listDepartments(client: JamfClient, settings: Record<string, unknown>): Promise<LiveDepartment[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LiveDepartment>(DEPARTMENTS_PATH, pageSize)
  if (res.error) throw new Error(`Failed to list Jamf Pro departments: ${res.error}`)
  return res.nodes
}
