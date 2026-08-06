import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { createIntegration, getIntegrationDetails, updateIntegration } from '../../lib/gravityZoneApi'
import {
  extractIntegrationSpecs,
  findLiveIntegration,
  integrationFieldsMatch,
  listAllIntegrations,
  liveIntegrationId,
  parseSpecifics,
} from './_shared'

export interface IntegrationRollbackEntry {
  name: string
  action: 'created' | 'updated' | 'unchanged'
  newId?: string
  prior?: { name: string; specifics: Record<string, unknown> | null }
}

/**
 * Deploy GravityZone integrations, reconciled by name:
 *   create: integrations.createIntegration    when no live integration has this name
 *   update: integrations.updateIntegration    when the integration exists but name/specifics differ
 *   no-op:  nothing                            when the live integration (full detail) already matches
 *
 * `type` is immutable after creation (updateIntegration has no type
 * parameter) — a declared type that differs from the live integration's type
 * is never sent and is only noted in the returned message, never failed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.name)
  const previous: IntegrationRollbackEntry[] = []
  const deployed: string[] = []
  const typeMismatchNotes: string[] = []

  try {
    const live = await listAllIntegrations(client)

    for (const spec of specs) {
      const { value: specifics } = parseSpecifics(spec)
      const match = findLiveIntegration(live, spec.name)

      if (!match) {
        const created = await createIntegration(client, { name: spec.name, type: spec.type, specifics: specifics ?? {} })
        previous.push({ name: spec.name, action: 'created', newId: created.id })
        live.push({ id: created.id, name: spec.name, type: spec.type, specifics: specifics ?? {} })
      } else {
        const id = liveIntegrationId(match)
        const full = (await getIntegrationDetails(client, id)) ?? match

        if (typeof full.type === 'number' && full.type !== spec.type) {
          typeMismatchNotes.push(
            `"${spec.name}": declared type ${spec.type} differs from GravityZone's live type ${full.type} and was ignored (type is immutable).`,
          )
        }

        if (integrationFieldsMatch(spec, specifics, full)) {
          previous.push({ name: spec.name, action: 'unchanged' })
        } else {
          previous.push({ name: spec.name, action: 'updated', prior: { name: full.name ?? spec.name, specifics: full.specifics ?? null } })
          await updateIntegration(client, { integrationId: id, name: spec.name, specifics: specifics ?? {} })
        }
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message:
        `Applied ${deployed.length} integration(s): ${deployed.join(', ') || '(none)'}` +
        (typeMismatchNotes.length ? ` Note: ${typeMismatchNotes.join(' ')}` : ''),
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Integration deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
