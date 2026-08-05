import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { readAcsSettings, resolveAcsToken, resolveStackName, type AcsRequestOptions } from '../../lib/acs'
import { describeTarget, resolveTargets, withTarget } from '../../lib/acsIdentity'
import { ROLE_QUOTA_FIELDS, extractRoleSpecs, normalizeLiveList, type RoleSpec, type RoleTransport } from './validate'
import {
  ACS_ROLES_COLLECTION_PATH,
  buildAcsRolePayload,
  createAcsRole,
  getAcsRole,
  toAcsRoleRollbackPrior,
  updateAcsRole,
} from './acsRoles'

/**
 * Deploy role configuration to a Splunk Cloud stack, over ONE OF TWO
 * transports selected per role item (`spec.transport`, see validate.ts):
 *
 *   REST (default):  /services/authorization/roles on stack management port
 *                     8089 — unchanged since this type shipped.
 *   ACS (opt-in):     /adminconfig/v2/roles — the same JWT this app already
 *                     needs everywhere else, no port-8089/allow-list
 *                     prerequisites, but scoped to whichever search-head(s)
 *                     `spec.searchHeadTargets` names (see acsRoles.ts and
 *                     lib/acsIdentity.ts for why that targeting exists).
 *
 * Both transports capture the prior state of every touched resource as
 * `rollbackData`, including on partial failure, so rollback can revert
 * exactly what was applied. A field left blank on the canvas is NOT sent on
 * either transport, so the role keeps whatever it inherits or already has.
 */

export const ROLES_BASE_PATH = '/services/authorization/roles'

/** REST parameters snapshotted from the live role for rollback. */
const REST_ROLLBACK_KEYS = [
  'imported_roles',
  'capabilities',
  'srchIndexesAllowed',
  'srchIndexesDefault',
  'srchFilter',
  'srchTimeWin',
  'srchTimeEarliest',
  'defaultApp',
  ...ROLE_QUOTA_FIELDS,
] as const

/** One transport target's captured state, for rollback. `target` is REST/ACS-default when undefined. */
export interface RoleTargetRollbackEntry {
  target?: string
  existed: boolean
  prior?: Record<string, unknown>
}

/**
 * Rollback bookkeeping for one role. REST always has exactly one entry in
 * `targets` (the whole cluster, `target: undefined`); ACS has one entry PER
 * declared search-head target (or one untargeted entry when none were
 * declared).
 */
export interface RoleRollbackEntry {
  name: string
  transport: RoleTransport
  targets: RoleTargetRollbackEntry[]
}

/**
 * Pre-v1.12.0 rollback data was flat and REST-only:
 * `{ name, existed, prior? }`, one entry per role. Normalizing every entry
 * through this function on read makes rollback.ts (and any future reader)
 * shape-tolerant of deployments made by the OLD code, without a data
 * migration — see rollback.ts.
 */
export function normalizeRoleRollbackEntry(raw: unknown): RoleRollbackEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.name !== 'string') return null

  if (Array.isArray(entry.targets)) {
    return {
      name: entry.name,
      transport: entry.transport === 'acs' ? 'acs' : 'rest',
      targets: entry.targets.map(normalizeTargetEntry),
    }
  }

  // Legacy flat shape (pre-v1.12.0): always REST, always one untargeted entry.
  return {
    name: entry.name,
    transport: 'rest',
    targets: [
      {
        target: undefined,
        existed: entry.existed === true,
        prior: isRecord(entry.prior) ? entry.prior : undefined,
      },
    ],
  }
}

function normalizeTargetEntry(raw: unknown): RoleTargetRollbackEntry {
  const o = isRecord(raw) ? raw : {}
  return {
    target: typeof o.target === 'string' ? o.target : undefined,
    existed: o.existed === true,
    prior: isRecord(o.prior) ? o.prior : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface StepOutcome {
  entry: RoleRollbackEntry
  error?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)

  const needsRest = specs.some((s) => s.transport === 'rest')
  const needsAcs = specs.some((s) => s.transport === 'acs')

  const restToken = resolveRestToken(ctx.credential)
  if (needsRest && !restToken) {
    return { success: false, message: REST_TOKEN_MISSING }
  }

  const acsToken = resolveAcsToken(ctx.credential)
  if (needsAcs && !acsToken) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const { timeoutMs: restTimeoutMs } = readRestSettings(ctx.settings)
  const stackHost = resolveStackHost(ctx.component.hostname)
  const restBaseUrl = buildRestUrl(ctx.component)
  const restAuth = restToken ? buildAuthHeader(restToken) : {}

  const acsSettings = readAcsSettings(ctx.settings)
  const baseStack = resolveStackName(ctx.component.hostname)
  const acsBase: AcsRequestOptions = {
    baseUrl: acsSettings.baseUrl,
    stack: baseStack,
    token: acsToken ?? '',
    timeoutMs: acsSettings.timeoutMs,
  }

  const rollbackState: RoleRollbackEntry[] = []
  const deployedRoles: string[] = []
  const createdRoles: string[] = []

  try {
    for (const spec of specs) {
      const outcome: StepOutcome =
        spec.transport === 'acs'
          ? await deployAcsRole(acsBase, baseStack, spec)
          : await deployRestRole(restBaseUrl, restAuth, spec, restTimeoutMs)

      rollbackState.push(outcome.entry)
      if (outcome.error) throw new Error(outcome.error)

      if (outcome.entry.targets.some((t) => !t.existed)) createdRoles.push(spec.name)
      deployedRoles.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployedRoles.length} role(s) to stack "${stackHost}": ${deployedRoles.join(', ')}`,
      artifacts: {
        stack: stackHost,
        restEndpoint: `${restBaseUrl}${ROLES_BASE_PATH}`,
        acsEndpoint: `${acsSettings.baseUrl}/${baseStack}/adminconfig/v2${ACS_ROLES_COLLECTION_PATH}`,
        deployedRoles,
        createdRoles,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment to stack "${stackHost}" failed after ${deployedRoles.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: {
        stack: stackHost,
        deployedRoles,
        createdRoles,
        failedAt: specs[deployedRoles.length]?.name,
      },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- REST transport -----------------------------------------------------------

async function deployRestRole(
  baseUrl: string,
  auth: Record<string, string>,
  spec: RoleSpec,
  timeoutMs: number,
): Promise<StepOutcome> {
  const rolePath = `${ROLES_BASE_PATH}/${encodeURIComponent(spec.name)}`

  try {
    // Capture prior state for rollback. A connection/auth failure throws here
    // rather than being mistaken for "role does not exist".
    const existing = await getEntityContent(baseUrl, auth, rolePath, timeoutMs)

    if (existing) {
      const prior: Record<string, unknown> = {}
      for (const key of REST_ROLLBACK_KEYS) {
        if (existing[key] !== undefined) prior[key] = existing[key]
      }
      await postForm(baseUrl, auth, rolePath, buildRolePayload(spec), timeoutMs)
      return { entry: { name: spec.name, transport: 'rest', targets: [{ existed: true, prior }] } }
    }

    await postForm(baseUrl, auth, ROLES_BASE_PATH, { name: spec.name, ...buildRolePayload(spec) }, timeoutMs)
    return { entry: { name: spec.name, transport: 'rest', targets: [{ existed: false }] } }
  } catch (error) {
    return {
      entry: { name: spec.name, transport: 'rest', targets: [] },
      error: `role "${spec.name}" (REST): ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * Map canvas fields to Splunk REST parameters. Only fields the canvas actually
 * declares are included — an omitted field is left untouched on the role.
 */
export function buildRolePayload(
  spec: RoleSpec,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  if (spec.importedRoles) payload.imported_roles = spec.importedRoles
  if (spec.capabilities) payload.capabilities = spec.capabilities
  if (spec.srchIndexesAllowed) payload.srchIndexesAllowed = spec.srchIndexesAllowed
  if (spec.srchIndexesDefault) payload.srchIndexesDefault = spec.srchIndexesDefault
  if (spec.srchFilter !== undefined) payload.srchFilter = spec.srchFilter
  if (spec.srchTimeWin !== undefined) payload.srchTimeWin = spec.srchTimeWin
  if (spec.srchTimeEarliest !== undefined) payload.srchTimeEarliest = spec.srchTimeEarliest
  if (spec.defaultApp !== undefined) payload.defaultApp = spec.defaultApp

  for (const key of ROLE_QUOTA_FIELDS) {
    const value = spec.quotas[key]
    if (value !== undefined) payload[key] = value
  }

  return payload
}

/**
 * Rebuild a REST payload from a rollback snapshot. Splunk replaces a
 * multi-value parameter with whatever is posted, so a list that was previously
 * EMPTY must be sent as an empty string to clear it — omitting the key would
 * leave the deploy's values in place.
 */
export function buildRestorePayload(
  prior: Record<string, unknown>,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  for (const key of ['imported_roles', 'capabilities', 'srchIndexesAllowed', 'srchIndexesDefault'] as const) {
    if (!(key in prior)) continue
    const list = normalizeLiveList(prior[key])
    payload[key] = list.length > 0 ? list : ''
  }

  for (const key of ['srchFilter', 'defaultApp', 'srchTimeWin', 'srchTimeEarliest', ...ROLE_QUOTA_FIELDS] as const) {
    const value = prior[key]
    if (value === undefined || value === null) continue
    payload[key] = String(value)
  }

  return payload
}

// --- ACS transport --------------------------------------------------------------

async function deployAcsRole(
  acsBase: AcsRequestOptions,
  baseStack: string,
  spec: RoleSpec,
): Promise<StepOutcome> {
  const targets: RoleTargetRollbackEntry[] = []

  for (const target of resolveTargets(spec.searchHeadTargets)) {
    const acs = withTarget(acsBase, baseStack, target)
    try {
      const existing = await getAcsRole(acs, spec.name)
      if (existing) {
        targets.push({ target, existed: true, prior: toAcsRoleRollbackPrior(existing) })
        await updateAcsRole(acs, spec.name, buildAcsRolePayload(spec))
      } else {
        await createAcsRole(acs, spec)
        targets.push({ target, existed: false })
      }
    } catch (error) {
      return {
        entry: { name: spec.name, transport: 'acs', targets },
        error: `role "${spec.name}" on ${describeTarget(target)} (ACS): ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      }
    }
  }

  return { entry: { name: spec.name, transport: 'acs', targets } }
}
