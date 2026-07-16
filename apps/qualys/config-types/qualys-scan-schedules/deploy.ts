import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import {
  extractScheduleSpecs,
  parseScheduleObject,
  scheduleKey,
  type LiveSchedule,
  type ScheduleSpec,
} from './validate'

export const SCHEDULE_PATH = '/api/2.0/fo/schedule/scan/'

export interface ScheduleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveSchedule
}

/**
 * Deploy Qualys scan schedules via the classic v2 API.
 *
 * Identity is the scan title natural key: list schedules, match on the title,
 * then update an existing schedule by id or create a new one. Timing and any
 * extra parameters come from the schedule JSON; the option profile is referenced
 * by title and the target by asset group titles.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractScheduleSpecs(ctx.canvas).filter(
    (s) => s.scanTitle && s.optionTitle && !parseScheduleObject(s.scheduleJson).error,
  )
  const rollbackState: ScheduleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSchedules(client)
    const byKey = new Map(existing.map((s) => [scheduleKey({ scanTitle: s.title }), s]))

    for (const spec of specs) {
      const label = spec.scanTitle
      const key = scheduleKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(SCHEDULE_PATH, buildUpdateParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update scan schedule "${label}": ${failed}`)
      } else {
        const res = await client.post(SCHEDULE_PATH, buildCreateParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create scan schedule "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Scan schedule "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scan schedule(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedSchedules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan schedule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedSchedules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all scan schedules; throws on a non-OK response. */
export async function listSchedules(client: QualysClient): Promise<LiveSchedule[]> {
  const res = await client.list(SCHEDULE_PATH, {}, 'SCAN')
  if (!res.ok) {
    throw new Error(`Failed to list scan schedules: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.blocks.map(parseScheduleBlock).filter((s) => s.id && s.title)
}

/** Parse one <SCAN> block into a LiveSchedule. */
export function parseScheduleBlock(block: string): LiveSchedule {
  const optionProfile = block.match(/<OPTION_PROFILE>([\s\S]*?)<\/OPTION_PROFILE>/i)?.[1] ?? ''
  return {
    id: xmlText(block, 'ID'),
    title: xmlText(block, 'TITLE'),
    active: xmlText(block, 'ACTIVE') === '1',
    optionProfileTitle: xmlText(optionProfile, 'TITLE'),
  }
}

/** Split a comma-separated list of titles (which may contain spaces) into a CSV. */
export function normalizeTitleCsv(raw: string): string {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
}

/** Build the shared create/update parameter set from a spec (excludes action/id). */
export function scheduleParams(spec: ScheduleSpec): QualysParams {
  const params: QualysParams = {
    scan_title: spec.scanTitle,
    active: spec.active ? 1 : 0,
    option_title: spec.optionTitle,
  }

  const groups = normalizeTitleCsv(spec.assetGroupTitles)
  if (groups) {
    params.asset_groups = groups
    params.target_from = 'assets'
  }

  const details = parseScheduleObject(spec.scheduleJson).value ?? {}
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') params[key] = value ? 1 : 0
    else if (typeof value === 'number' || typeof value === 'string') params[key] = value
    else params[key] = String(value)
  }
  return params
}

export function buildCreateParams(spec: ScheduleSpec): QualysParams {
  return { action: 'create', ...scheduleParams(spec) }
}

export function buildUpdateParams(spec: ScheduleSpec, id: string): QualysParams {
  return { action: 'update', id, ...scheduleParams(spec) }
}
