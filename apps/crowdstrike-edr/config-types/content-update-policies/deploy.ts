import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope, type FalconClient } from '../../lib/falcon'
import {
  currentGroupIds,
  findPolicyByName,
  policyAction,
  syncHostGroups,
} from '../../lib/policyAdapter'
import {
  CONTENT_UPDATE_ENDPOINTS,
  extractContentUpdatePolicySpecs,
  parseContentUpdateSettings,
  type ContentUpdateSettings,
  type LiveContentUpdatePolicy,
} from './validate'

export interface ContentUpdatePolicyRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Prior full settings object — content update settings converge wholesale. */
    settings?: ContentUpdateSettings
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
  }
}

/**
 * Deploy content update policies to a Falcon tenant via the Content Update
 * Policy API (a member of the shared policy family — see lib/policyAdapter).
 *
 * For each declared policy:
 *   - GET   /policy/combined/content-update/v1?filter=name:~'…'  — find + capture prior state
 *   - PATCH /policy/entities/content-update/v1   — update existing (settings sent as-is)
 *   - POST  /policy/entities/content-update/v1   — create missing (new policies start disabled)
 *   - POST  /policy/entities/content-update-actions/v1?action_name=enable|disable — converge enablement
 *   - POST  …?action_name=add-host-group|remove-host-group — converge assignments to the declared list
 *
 * Content update policies are not per-platform, so lookups pass no platform.
 * The settings object is written wholesale (drift detection compares the same).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractContentUpdatePolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ContentUpdatePolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { settings, errors: settingErrors } = parseContentUpdateSettings(spec.settingsRaw)
      if (settingErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid settings — ${settingErrors[0]}`)
      }

      const existing = await findContentUpdatePolicy(client, spec.name)

      if (existing?.id) {
        const entry: ContentUpdatePolicyRollbackEntry = {
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description
            // this deployment sets on a policy that previously had none.
            description: existing.description ?? '',
            enabled: existing.enabled,
            settings: existing.settings,
            groupsAdded: [],
            groupsRemoved: [],
          },
        }
        rollbackState.push(entry)

        // description is always sent so clearing it on the canvas converges
        // the live policy (and drift detection agrees with deploy)
        const update: Record<string, unknown> = {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
        }
        if (settings) update.settings = settings

        const res = await client.request('PATCH', CONTENT_UPDATE_ENDPOINTS.entity, {
          body: { resources: [update] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update policy "${spec.name}": ${patchFailure}`)
        }

        if (existing.enabled !== spec.enabled) {
          await policyAction(
            client,
            CONTENT_UPDATE_ENDPOINTS,
            existing.id,
            spec.enabled ? 'enable' : 'disable',
          )
        }
        // Records each successful attach/detach on entry.prior so rollback
        // can reverse exactly the assignments this deployment changed, even
        // after a partial failure.
        await syncHostGroups(
          client,
          CONTENT_UPDATE_ENDPOINTS,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )
      } else {
        const create: Record<string, unknown> = { name: spec.name }
        if (spec.description !== undefined) create.description = spec.description
        if (settings) create.settings = settings

        const res = await client.request('POST', CONTENT_UPDATE_ENDPOINTS.entity, {
          body: { resources: [create] },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create policy "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LiveContentUpdatePolicy>(res.body)?.resources?.[0]
        rollbackState.push({
          name: spec.name,
          existed: false,
          id: created?.id,
        })
        if (!created?.id) {
          throw new Error(`Policy "${spec.name}" was created but the API returned no policy id`)
        }

        // New policies always start disabled
        if (spec.enabled) await policyAction(client, CONTENT_UPDATE_ENDPOINTS, created.id, 'enable')
        await syncHostGroups(client, CONTENT_UPDATE_ENDPOINTS, spec.name, created.id, spec.hostGroups, [])
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} content update policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Content update policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Look up a content update policy by exact name. Delegates to the shared
 * policy adapter (name:~'…' contains match + client-side exact pin, paged);
 * the family is not per-platform, so no platform is passed.
 */
export async function findContentUpdatePolicy(
  client: FalconClient,
  name: string,
): Promise<LiveContentUpdatePolicy | null> {
  return (await findPolicyByName(
    client,
    CONTENT_UPDATE_ENDPOINTS,
    name,
  )) as LiveContentUpdatePolicy | null
}
