import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, decodeXmlEntities, qualysErrorMessage, xmlText, type QualysClient, type QualysResponse } from '../../lib/qualys'
import { extractUserSpecs, userKey, type LiveUser, type UserSpec } from './validate'

export const USER_PATH = '/msp/user.php'
export const USER_LIST_PATH = '/msp/user_list.php'

// Roles for which Qualys rejects an `asset_groups` assignment outright.
const ROLES_WITHOUT_ASSET_GROUPS = new Set<string>(['manager', 'unit_manager'])

export interface UserRollbackEntry {
  key: string
  label: string
  existed: boolean
  login?: string
  prior?: LiveUser
}

/**
 * Deploy Qualys user accounts via `/msp/user.php` (a different classic-API
 * family from `/api/2.0/fo/...` — same Basic auth + `X-Requested-With` header,
 * but its own `USER_OUTPUT`/`<RETURN status="...">` envelope instead of
 * `SIMPLE_RETURN`).
 *
 * Identity is the EMAIL natural key, not `login` — Qualys generates the login
 * itself on `action=add` (it cannot be chosen), so it is a live-resolved
 * artifact rather than desired state. Every declared user is matched against
 * the live account list by email; a match is edited by its resolved `login`,
 * a non-match is added. There is no delete-user API — see rollback.ts.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.email)
  const rollbackState: UserRollbackEntry[] = []
  const deployed: string[] = []
  const createdEmails: string[] = []

  try {
    let byEmail = new Map((await listUsers(client)).map((u) => [userKey(u), u]))

    for (const spec of specs) {
      const label = spec.email
      const key = userKey(spec)
      const live = byEmail.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, login: live.login, prior: live })
        const res = await client.post(USER_PATH, buildEditParams(spec, live.login))
        const failed = userWriteError(res)
        if (failed) throw new Error(`Failed to update user "${label}": ${failed}`)
      } else {
        const res = await client.post(USER_PATH, buildAddParams(spec))
        const failed = userWriteError(res)
        if (failed) throw new Error(`Failed to create user "${label}": ${failed}`)
        rollbackState.push({ key, label, existed: false })
        createdEmails.push(key)
      }
      deployed.push(label)
    }

    // Resolve the Qualys-assigned login for every user just created, in ONE
    // extra list call, so rollback can best-effort deactivate them.
    if (createdEmails.length > 0) {
      byEmail = new Map((await listUsers(client)).map((u) => [userKey(u), u]))
      for (const entry of rollbackState) {
        if (!entry.existed && !entry.login) entry.login = byEmail.get(entry.key)?.login
      }
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * The first non-empty value found under any of `tags` in `block`. `user_list.php`
 * element names are less exhaustively documented than the `/api/2.0/fo/...`
 * family this app otherwise uses, so lookups defensively try each plausible
 * name — `xmlText` itself does not care about ancestor nesting (e.g. a
 * `CONTACT_INFO` wrapper), only the tag name.
 */
function pickFirst(block: string, tags: string[]): string {
  for (const tag of tags) {
    const value = xmlText(block, tag)
    if (value) return value
  }
  return ''
}

/** List every user account, following the trailing WARNING/URL pagination pointer. */
export async function listUsers(client: QualysClient): Promise<LiveUser[]> {
  const res = await client.list(USER_LIST_PATH, {}, 'USER')
  if (!res.ok) {
    throw new Error(`Failed to list users: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.blocks.map(parseUserBlock).filter((u) => u.email)
}

/** Parse one `<USER>` block into a LiveUser. */
export function parseUserBlock(block: string): LiveUser {
  return {
    login: pickFirst(block, ['USER_LOGIN', 'LOGIN']),
    id: pickFirst(block, ['USER_ID', 'ID']),
    email: pickFirst(block, ['EMAIL']),
    firstName: pickFirst(block, ['FIRSTNAME', 'FIRST_NAME']),
    lastName: pickFirst(block, ['LASTNAME', 'LAST_NAME']),
    jobTitle: pickFirst(block, ['TITLE', 'JOB_TITLE']),
  }
}

/**
 * `/msp/user.php` reports success/failure as `<RETURN status="SUCCESS">` +
 * `<MESSAGE>`, NOT the `SIMPLE_RETURN`/`<CODE>` envelope the rest of this app's
 * classic-API calls use — a different API family with its own contract.
 * NON-UNION `string | null` (the platform handler loader can't narrow
 * discriminated unions).
 */
export function userWriteError(res: QualysResponse): string | null {
  if (!res.ok) return userErrorMessage(res)
  const match = res.body.match(/<RETURN\s+status="([^"]*)"/i)
  const status = match ? match[1] : ''
  if (status.toUpperCase() === 'SUCCESS') return null
  return userErrorMessage(res)
}

/** Human-readable message from a `USER_OUTPUT` response. */
export function userErrorMessage(res: QualysResponse): string {
  const message = xmlText(res.body, 'MESSAGE')
  if (message) return decodeXmlEntities(message)
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

function assetGroupsParam(spec: UserSpec): string | undefined {
  if (!spec.assetGroups || ROLES_WITHOUT_ASSET_GROUPS.has(spec.userRole)) return undefined
  return spec.assetGroups
}

/** Fields valid on `action=add` — includes the Add-only login-credential/permission fields. */
export function buildAddParams(spec: UserSpec): Record<string, string | number> {
  const params: Record<string, string | number> = {
    action: 'add',
    user_role: spec.userRole,
    business_unit: spec.businessUnit,
    first_name: spec.firstName,
    last_name: spec.lastName,
    title: spec.jobTitle,
    email: spec.email,
    address1: spec.address1,
    city: spec.city,
    country: spec.country,
    send_email: spec.sendEmail ? 1 : 0,
  }
  if (spec.phone) params.phone = spec.phone
  if (spec.address2) params.address2 = spec.address2
  if (spec.state) params.state = spec.state
  if (spec.zipCode) params.zip_code = spec.zipCode
  if (spec.externalId) params.external_id = spec.externalId
  const assetGroups = assetGroupsParam(spec)
  if (assetGroups) params.asset_groups = assetGroups
  return params
}

/**
 * Fields valid on `action=edit` — `user_role`, `business_unit` and `send_email`
 * are "Required for Add, not valid for Edit" per the Qualys API guide and are
 * deliberately omitted (sending them on an edit request errors).
 */
export function buildEditParams(spec: UserSpec, login: string): Record<string, string> {
  const params: Record<string, string> = {
    action: 'edit',
    login,
    first_name: spec.firstName,
    last_name: spec.lastName,
    title: spec.jobTitle,
    email: spec.email,
    address1: spec.address1,
    city: spec.city,
    country: spec.country,
  }
  if (spec.phone) params.phone = spec.phone
  if (spec.address2) params.address2 = spec.address2
  if (spec.state) params.state = spec.state
  if (spec.zipCode) params.zip_code = spec.zipCode
  if (spec.externalId) params.external_id = spec.externalId
  const assetGroups = assetGroupsParam(spec)
  if (assetGroups) params.asset_groups = assetGroups
  return params
}
