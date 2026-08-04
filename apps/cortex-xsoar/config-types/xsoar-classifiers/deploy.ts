import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import {
  CLASSIFICATION_VERSION,
  CLASSIFIER_TYPE,
  isProtectedClassification,
  parseConfigBlob,
  saveClassification,
  searchClassifications,
  type LiveClassification,
} from '../lib/xsoarClassification'
import { extractClassifierSpecs, type ClassifierSpec } from './validate'

export interface ClassifierRollbackEntry {
  id: string
  existed: boolean
  prior?: LiveClassification
}

/** Build the body sent to POST /classifier/import for a create or update. */
function buildClassifierBody(spec: ClassifierSpec, live: LiveClassification | null): Record<string, unknown> {
  const blob = parseConfigBlob(spec.configJson).value
  return {
    ...blob,
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    type: CLASSIFIER_TYPE,
    feed: spec.feed,
    defaultIncidentType: spec.defaultIncidentType ?? '',
    version: typeof live?.version === 'number' ? live.version : CLASSIFICATION_VERSION,
  }
}

/**
 * Deploy Cortex XSOAR classifiers via the server REST API.
 *
 * Identity is the caller-chosen classifier `id`. List every classifier/mapper
 * (POST /classifier/search, filtered to `type === "classification"`), match on
 * id, then upsert with POST /classifier/import. Built-in / locked classifiers
 * are never modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractClassifierSpecs(ctx.canvas).filter((s) => s.id)
  const rollbackState: ClassifierRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await searchClassifications(client)
    const byId = new Map(existing.filter((c) => c.type === CLASSIFIER_TYPE && c.id).map((c) => [c.id as string, c]))

    for (const spec of specs) {
      const live = byId.get(spec.id) ?? null

      if (live && isProtectedClassification(live)) {
        throw new Error(`Classifier "${spec.id}" is a built-in/locked classifier and cannot be modified`)
      }

      const body = buildClassifierBody(spec, live)
      await saveClassification(client, spec.id, body)
      rollbackState.push({ id: spec.id, existed: live !== null, prior: live ?? undefined })
      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} classifier(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedClassifiers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Classifier deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedClassifiers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
