import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractFileTypeRuleSpecs, type FileTypeRuleSpec, type LiveFileTypeRule } from './validate'

export interface FileTypeRuleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** Full prior rule body captured before update, PUT back verbatim on rollback. */
  prior?: LiveFileTypeRule
}

/**
 * A live rule is the protected built-in default when ZIA flags it as such. The
 * default file type rule is the catch-all evaluated last; it must NEVER be
 * modified or deleted, so deploy throws when an authored name matches it.
 */
export function isProtectedDefaultRule(live: LiveFileTypeRule): boolean {
  return live.isDefaultRule === true || live.defaultRule === true || live.predefined === true
}

/**
 * Deploy ZIA file type control rules via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /fileTypeRules, match by name,
 * then PUT an existing rule or POST a new one. ZIA STAGES every write — nothing
 * takes effect until activation — so this writes all rules, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * The built-in DEFAULT rule is protected: if a name matches the live default
 * rule, deploy throws so the author renames rather than overwriting it. The
 * default rule is never created, updated, or deleted by this handler.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractFileTypeRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FileTypeRuleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listFileTypeRules(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isProtectedDefaultRule(live)) {
        throw new Error(
          `"${spec.name}" is the protected default file type rule and cannot be modified or deleted — rename your rule to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.zia('PUT', `/fileTypeRules/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update file type rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/fileTypeRules', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create file type rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveFileTypeRule>(res.body)
        if (created?.id == null) {
          throw new Error(`File type rule "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA file type rule(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRules: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA file type rule(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `File type rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA file type rules; throws on a non-OK response. */
export async function listFileTypeRules(client: ZscalerClient): Promise<LiveFileTypeRule[]> {
  const res = await client.ziaGetAll<LiveFileTypeRule>('/fileTypeRules')
  if (!res.ok) {
    throw new Error(
      `Failed to list file type rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a file type rule by name; null when absent. */
export async function findFileTypeRule(
  client: ZscalerClient,
  name: string,
): Promise<LiveFileTypeRule | null> {
  const all = await listFileTypeRules(client)
  return all.find((r) => r.name === name) ?? null
}

/**
 * Build the rule body. The first-class scalars (order/state/action) are set,
 * then the `rule_json` escape hatch is spread over them so advanced JSON keys
 * win — this is where fileTypes[] and object references live. `name` is pinned
 * last so it always comes from the first-class name field, never from JSON.
 */
function buildPayload(spec: FileTypeRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    order: spec.order ?? 1,
    state: spec.state,
    action: spec.action,
    ...(spec.ruleJson ?? {}),
  }
  body.name = spec.name
  return body
}
