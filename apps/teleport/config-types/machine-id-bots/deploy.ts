import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage, type TeleportClient } from '../../lib/teleport'
import { extractBotSpecs, type BotSpec, type BotTrait } from './validate'

export interface BotRollbackEntry {
  botName: string
  existed: boolean
  priorRoles?: string[]
  priorTraits?: BotTrait[]
  priorMaxSessionTtl?: string | null
  priorDescription?: string | null
}

/**
 * A bot's live shape from GET .../machine-id/bot/{name} is the raw
 * `machineidv1.Bot` protobuf message (lib/web/machineid.go's getBot returns it
 * directly, unlike every other handler in this app which returns a
 * hand-written JSON struct). Its exact wire casing (protojson camelCase vs.
 * plain-Go snake_case) was not independently verified against a live cluster,
 * so both are read defensively here — see README.md's Coverage notes.
 */
interface LiveBot {
  spec?: {
    roles?: string[]
    traits?: Array<{ name?: string; values?: string[] }>
    max_session_ttl?: string
    maxSessionTtl?: string
  }
  metadata?: { description?: string }
}

function readLiveBot(body: string): { roles: string[]; traits: BotTrait[]; maxSessionTtl: string | null; description: string | null } | null {
  const parsed = parseJson<LiveBot>(body)
  if (!parsed) return null
  const spec = parsed.spec ?? {}
  return {
    roles: Array.isArray(spec.roles) ? spec.roles : [],
    traits: Array.isArray(spec.traits)
      ? spec.traits.map((t) => ({ name: t.name ?? '', values: Array.isArray(t.values) ? t.values : [] }))
      : [],
    maxSessionTtl: spec.max_session_ttl ?? spec.maxSessionTtl ?? null,
    description: parsed.metadata?.description ?? null,
  }
}

/** GET a bot by name; null on 404 (absent). Shared by deploy, healthCheck and driftDetect. */
export async function getBot(client: TeleportClient, botName: string) {
  const site = await client.resolveSite()
  const res = await client.request('GET', `/v1/webapi/sites/${encodeURIComponent(site)}/machine-id/bot/${encodeURIComponent(botName)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read bot "${botName}": ${teleportErrorMessage(res)}`)
  return readLiveBot(res.body)
}

/**
 * Deploy Machine ID bots via the Teleport Proxy web API (lib/web/machineid.go):
 *   - POST /v1/webapi/sites/{site}/machine-id/bot          — create (accepts botName/roles/traits only)
 *   - PUT  /v3/webapi/sites/{site}/machine-id/bot/{name}    — update (roles/traits/max_session_ttl/description,
 *                                                              via a field mask - only fields present are changed)
 * Because create does not accept max_session_ttl/description, a bot declaring
 * either follows its create with an immediate v3 update to set them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractBotSpecs(ctx.canvas).filter((s) => s.botName && s.roles.length > 0)
  const rollbackState: BotRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const site = await client.resolveSite()

    for (const spec of specs) {
      const existing = await getBot(client, spec.botName)

      if (existing) {
        rollbackState.push({
          botName: spec.botName,
          existed: true,
          priorRoles: existing.roles,
          priorTraits: existing.traits,
          priorMaxSessionTtl: existing.maxSessionTtl,
          priorDescription: existing.description,
        })
        await updateBot(client, site, spec)
      } else {
        rollbackState.push({ botName: spec.botName, existed: false })
        const res = await client.request('POST', `/v1/webapi/sites/${encodeURIComponent(site)}/machine-id/bot`, {
          body: { botName: spec.botName, roles: spec.roles, traits: spec.traits },
        })
        if (!res.ok) throw new Error(`Failed to create bot "${spec.botName}": ${teleportErrorMessage(res)}`)

        // Create ignores max_session_ttl/description — a follow-up update sets them.
        if (spec.maxSessionTtl || spec.description) {
          await updateBot(client, site, spec)
        }
      }

      deployed.push(spec.botName)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} bot(s) to Teleport at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedBots: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Bot deployment failed after ${deployed.length} of ${specs.length} bot(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedBots: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

async function updateBot(client: TeleportClient, site: string, spec: BotSpec | RestoreSpec): Promise<void> {
  const res = await client.request(
    'PUT',
    `/v3/webapi/sites/${encodeURIComponent(site)}/machine-id/bot/${encodeURIComponent(spec.botName)}`,
    {
      body: {
        roles: spec.roles,
        traits: spec.traits.map((t) => ({ name: t.name, values: t.values })),
        max_session_ttl: spec.maxSessionTtl ?? '',
        description: spec.description,
      },
    },
  )
  if (!res.ok) throw new Error(`Failed to update bot "${spec.botName}": ${teleportErrorMessage(res)}`)
}

/** Shape `updateBot` needs, satisfied by both a canvas `BotSpec` and a rollback restore payload. */
interface RestoreSpec {
  botName: string
  roles: string[]
  traits: BotTrait[]
  maxSessionTtl: string | null
  description: string | null
}

export { updateBot }
export type { BotSpec, RestoreSpec }
