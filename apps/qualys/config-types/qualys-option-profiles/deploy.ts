import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlBlocks,
  xmlText,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import { flattenScalarParams, parseFlatScalarObject } from '../lib/qualysJson'
import {
  extractOptionProfileSpecs,
  optionProfileKey,
  type LiveOptionProfile,
  type OptionProfileSpec,
} from './validate'

// Create / update / delete VM option profiles.
export const OPTION_PROFILE_VM_PATH = '/api/2.0/fo/subscription/option_profile/vm/'
// Read (export) option profiles — the base endpoint, filtered to VM ("user") profiles.
export const OPTION_PROFILE_EXPORT_PATH = '/api/2.0/fo/subscription/option_profile/'

export interface OptionProfileRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveOptionProfile
}

/**
 * Deploy Qualys VM option profiles via the classic v2 API.
 *
 * Identity is the title natural key: export the VM option profiles, match on the
 * title (GROUP_NAME), then update an existing profile by id or create a new one.
 * global / default are reconciled from first-class fields; every other scan
 * setting comes from the flat settings JSON.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractOptionProfileSpecs(ctx.canvas).filter(
    (s) => s.title && !parseFlatScalarObject(s.settingsJson, { allowEmpty: true }).error,
  )
  const rollbackState: OptionProfileRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listOptionProfiles(client)
    const byKey = new Map(existing.map((p) => [optionProfileKey(p), p]))

    for (const spec of specs) {
      const label = spec.title
      const key = optionProfileKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(OPTION_PROFILE_VM_PATH, buildUpdateParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update option profile "${label}": ${failed}`)
      } else {
        const res = await client.post(OPTION_PROFILE_VM_PATH, buildCreateParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create option profile "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Option profile "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} option profile(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedOptionProfiles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Option profile deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedOptionProfiles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Export all VM ("user") option profiles; throws on a non-OK response. */
export async function listOptionProfiles(client: QualysClient): Promise<LiveOptionProfile[]> {
  const res = await client.get(OPTION_PROFILE_EXPORT_PATH, {
    action: 'export',
    output_format: 'XML',
    option_profile_type: 'user',
  })
  if (!res.ok) {
    throw new Error(
      `Failed to export option profiles: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return xmlBlocks(res.body, 'OPTION_PROFILE').map(parseOptionProfileBlock).filter((p) => p.id && p.title)
}

/** Parse one <OPTION_PROFILE> block (its BASIC_INFO) into a LiveOptionProfile. */
export function parseOptionProfileBlock(block: string): LiveOptionProfile {
  const basic = block.match(/<BASIC_INFO>([\s\S]*?)<\/BASIC_INFO>/i)?.[1] ?? block
  return {
    id: xmlText(basic, 'ID'),
    title: xmlText(basic, 'GROUP_NAME'),
    global: parseFlag(xmlText(basic, 'IS_GLOBAL')),
    isDefault: parseFlag(xmlText(basic, 'IS_DEFAULT')),
  }
}

/** Export renders flags as "1"/"0" or "Yes"/"No"; normalize both. */
export function parseFlag(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'yes' || v === 'true'
}

/** Build the shared create/update params from a spec (excludes action/id). */
export function optionProfileParams(spec: OptionProfileSpec): QualysParams {
  const settings = parseFlatScalarObject(spec.settingsJson, { allowEmpty: true }).value ?? {}
  // First-class fields win over any collision in the settings JSON.
  const params: QualysParams = { ...flattenScalarParams(settings) }
  params.title = spec.title
  params.global = spec.global ? 1 : 0
  params.default = spec.isDefault ? 1 : 0
  return params
}

export function buildCreateParams(spec: OptionProfileSpec): QualysParams {
  return { action: 'create', ...optionProfileParams(spec) }
}

export function buildUpdateParams(spec: OptionProfileSpec, id: string): QualysParams {
  return { action: 'update', id, ...optionProfileParams(spec) }
}
