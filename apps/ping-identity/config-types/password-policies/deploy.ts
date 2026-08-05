import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import {
  MIN_CHAR_LOWERCASE_KEY,
  MIN_CHAR_NUMERIC_KEY,
  MIN_CHAR_SPECIAL_KEY,
  MIN_CHAR_UPPERCASE_KEY,
  extractPasswordPolicySpecs,
  type LivePasswordPolicy,
  type PasswordPolicySpec,
} from './validate'

export interface PasswordPolicyRollbackEntry {
  name: string
  existed: boolean
  /** The policy id PingOne assigns - the rollback key (never the name). */
  id?: string
  /** Prior policy body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields PingOne returns on a policy but that must never be sent back. */
export const READONLY_POLICY_FIELDS = [
  'id',
  'environment',
  'createdAt',
  'updatedAt',
  '_links',
  'populationCount',
] as const

/**
 * Deploy password policies to a PingOne environment via the Password Policies
 * API. There is NO UPSERT, so for each declared policy:
 *   - GET  /passwordPolicies          - list (paginated) and match by exact name
 *   - PUT  /passwordPolicies/{id}     - update an existing policy (capture prior body)
 *   - POST /passwordPolicies          - create a missing policy (capture the new id)
 * A matched (existing) policy is only ever UPDATED in place; deploy never
 * deletes a policy that is absent from the canvas - rollback only reverts what
 * THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractPasswordPolicySpecs(ctx.canvas).filter((s) => s.name && s.minLength !== undefined)
  const rollbackState: PasswordPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildPasswordPolicyBody(spec)
      const existing = await findPasswordPolicyByName(client, spec.name)

      if (existing && existing.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyPolicyFields(existing),
        })

        const res = await client.request('PUT', `/passwordPolicies/${existing.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update password policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/passwordPolicies', { body })
        if (!res.ok) {
          throw new Error(`Failed to create password policy "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LivePasswordPolicy>(res.body)
        if (!created?.id) {
          throw new Error(`Password policy "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} password polic${deployed.length === 1 ? 'y' : 'ies'} to PingOne environment ${environmentId}: ${deployed.join(', ')}`,
      artifacts: { environmentId, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Password policy deployment failed after ${deployed.length} of ${specs.length} polic${specs.length === 1 ? 'y' : 'ies'}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a policy by exact (case-sensitive) name across the paginated policy list; null when absent. */
export async function findPasswordPolicyByName(
  client: PingOneClient,
  name: string,
): Promise<LivePasswordPolicy | null> {
  const res = await client.getAll<LivePasswordPolicy>('/passwordPolicies', 'passwordPolicies')
  if (!res.ok) {
    throw new Error(
      `Failed to list password policies while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** True when a minCharacters counter carries a meaningful (> 0) value. */
function isMeaningfulCount(value: number | undefined): value is number {
  return typeof value === 'number' && value > 0
}

/**
 * Build the create/update body for a password policy. Sub-objects (history,
 * length, lockout, minCharacters, alphabetSequenceRule, numberSequenceRule)
 * are included only when at least one of their fields carries a meaningful
 * value - an empty sub-object is never sent. qwertySequenceRule and
 * shiftedNumberRowSequenceRule are not modeled (future enhancement).
 */
export function buildPasswordPolicyBody(spec: PasswordPolicySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    excludesCommonlyUsedPasswords: spec.excludesCommonlyUsedPasswords,
    excludesProfileData: spec.excludesProfileData,
    notSimilarToCurrent: spec.notSimilarToCurrent,
  }

  if (spec.description !== undefined) body.description = spec.description
  if (spec.default !== undefined) body.default = spec.default

  if (spec.historyCount !== undefined && spec.historyRetentionDays !== undefined) {
    body.history = { count: spec.historyCount, retentionDays: spec.historyRetentionDays }
  }

  if (spec.minLength !== undefined) {
    body.length = spec.maxLength !== undefined ? { min: spec.minLength, max: spec.maxLength } : { min: spec.minLength }
  }

  if (spec.lockoutFailureCount !== undefined && spec.lockoutDurationSeconds !== undefined) {
    body.lockout = { failureCount: spec.lockoutFailureCount, durationSeconds: spec.lockoutDurationSeconds }
  }

  if (spec.maxAgeDays !== undefined) body.maxAgeDays = spec.maxAgeDays
  if (spec.minAgeDays !== undefined) body.minAgeDays = spec.minAgeDays

  const minCharacters: Record<string, number> = {}
  if (isMeaningfulCount(spec.minCharUppercase)) minCharacters[MIN_CHAR_UPPERCASE_KEY] = spec.minCharUppercase
  if (isMeaningfulCount(spec.minCharLowercase)) minCharacters[MIN_CHAR_LOWERCASE_KEY] = spec.minCharLowercase
  if (isMeaningfulCount(spec.minCharNumeric)) minCharacters[MIN_CHAR_NUMERIC_KEY] = spec.minCharNumeric
  if (isMeaningfulCount(spec.minCharSpecial)) minCharacters[MIN_CHAR_SPECIAL_KEY] = spec.minCharSpecial
  if (Object.keys(minCharacters).length > 0) body.minCharacters = minCharacters

  if (spec.minComplexity !== undefined) body.minComplexity = spec.minComplexity
  if (spec.minUniqueCharacters !== undefined) body.minUniqueCharacters = spec.minUniqueCharacters
  if (spec.maxRepeatedCharacters !== undefined) body.maxRepeatedCharacters = spec.maxRepeatedCharacters

  if (spec.alphabetSequenceMaxLength !== undefined) {
    body.alphabetSequenceRule = { maxLength: spec.alphabetSequenceMaxLength }
  }
  if (spec.numberSequenceMaxLength !== undefined) {
    body.numberSequenceRule = { maxLength: spec.numberSequenceMaxLength }
  }

  return body
}

/** Copy a live policy without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyPolicyFields(policy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(policy)) {
    if (!(READONLY_POLICY_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
