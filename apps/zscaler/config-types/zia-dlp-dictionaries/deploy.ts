import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractDlpDictionarySpecs,
  type DlpDictionarySpec,
  type DlpPattern,
  type DlpPhrase,
  type LiveDlpDictionary,
} from './validate'

export interface DlpDictionaryRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: {
    name?: string
    description?: string
    dictionaryType?: string
    phrases?: DlpPhrase[]
    patterns?: DlpPattern[]
    customPhraseMatchType?: string
  }
}

/**
 * Deploy custom ZIA DLP dictionaries via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /dlpDictionaries, match by
 * name, then PUT an existing dictionary or POST a new one. ZIA STAGES every
 * write — nothing takes effect until activation — so this writes all
 * dictionaries, then calls activate() ONCE at the end. If activation fails the
 * writes remain staged and rollbackData is returned so the platform can revert.
 *
 * PREDEFINED (built-in) dictionaries are read-only: if a name matches a live
 * dictionary whose `custom` flag is false, deploy throws so the author renames
 * rather than attempting to overwrite a built-in. Predefined dictionaries are
 * never deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractDlpDictionarySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DlpDictionaryRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listDlpDictionaries(client)
    const byName = new Map(existing.filter((d) => d.name).map((d) => [d.name as string, d]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.custom === false) {
        throw new Error(
          `"${spec.name}" is a predefined DLP dictionary and cannot be modified — rename your dictionary to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            dictionaryType: live.dictionaryType,
            phrases: live.phrases,
            patterns: live.patterns,
            customPhraseMatchType: live.customPhraseMatchType,
          },
        })
        const res = await client.zia('PUT', `/dlpDictionaries/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update DLP dictionary "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/dlpDictionaries', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create DLP dictionary "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveDlpDictionary>(res.body)
        if (created?.id == null) {
          throw new Error(`DLP dictionary "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA DLP dictionary(ies) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedDictionaries: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA DLP dictionary(ies) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedDictionaries: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `DLP dictionary deployment failed after ${deployed.length} of ${specs.length} dictionary(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedDictionaries: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA DLP dictionaries; throws on a non-OK response. */
export async function listDlpDictionaries(client: ZscalerClient): Promise<LiveDlpDictionary[]> {
  const res = await client.ziaGetAll<LiveDlpDictionary>('/dlpDictionaries')
  if (!res.ok) {
    throw new Error(
      `Failed to list DLP dictionaries: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a DLP dictionary by name; null when absent. */
export async function findDlpDictionary(
  client: ZscalerClient,
  name: string,
): Promise<LiveDlpDictionary | null> {
  const all = await listDlpDictionaries(client)
  return all.find((d) => d.name === name) ?? null
}

/**
 * Build the DLP dictionary API body. Phrases and patterns become the ZIA entry
 * shape ({ action, phrase|pattern }); `custom: true` marks this as a manageable
 * custom dictionary. description is always sent (even empty) so clearing it
 * converges the live dictionary.
 */
export function buildPayload(spec: DlpDictionarySpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description ?? '',
    dictionaryType: spec.dictionaryType,
    phrases: spec.phrases.map((phrase) => ({ action: 'PHRASE_COUNT_TYPE_ALL', phrase })),
    patterns: spec.patterns.map((pattern) => ({ action: 'PATTERN_COUNT_TYPE_ALL', pattern })),
    customPhraseMatchType: spec.customPhraseMatchType,
    custom: true,
  }
}
