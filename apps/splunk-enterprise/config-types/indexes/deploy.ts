import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm } from '../../lib/splunkApi'

/**
 * Deploy index configuration to a Splunk component via the REST API
 * (/services/data/indexes).
 *
 * Canvas → Splunk REST parameter mapping:
 *   maxDataSizeMB            → maxTotalDataSizeMB     (total index size cap)
 *   frozenTimeDays           → frozenTimePeriodInSecs (days × 86400)
 *   maxDataSizeMode(+CustomMB) → maxDataSize          (auto | auto_high_volume | <MB>)
 *   enableCompression        → journalCompression     (zstd when enabled; gzip default otherwise)
 *   enableTsidxReduction     → enableTsidxReduction
 *   tsidxReductionPeriodDays → timePeriodInSecBeforeTsidxReduction (days × 86400)
 *   datatype / homePath / coldPath / thawedPath → same names (create-only in Splunk)
 *   coldToFrozenDir          → coldToFrozenDir
 *
 * Rollback data captures the pre-deploy state of every existing index and
 * the names of indexes this deploy created, so rollback can restore or
 * remove them respectively.
 */

/** Settings Splunk only accepts at index creation time. */
const CREATE_ONLY_KEYS = ['datatype', 'homePath', 'coldPath', 'thawedPath'] as const

/** Writable settings we snapshot for rollback. */
const ROLLBACK_KEYS = [
  'maxTotalDataSizeMB',
  'frozenTimePeriodInSecs',
  'maxDataSize',
  'journalCompression',
  'coldToFrozenDir',
  'enableTsidxReduction',
  'timePeriodInSecBeforeTsidxReduction',
] as const

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'No credential provided for Splunk deployment' }
  }
  if (!connectivity) {
    return { success: false, message: 'No connectivity established to Splunk component' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  const rollbackSnapshot: Record<string, unknown>[] = []
  const createdIndexes: string[] = []
  const deployedIndexes: string[] = []

  try {
    for (const section of canvas.sections) {
      const fields = section.fields
      const indexName = fields.name as string
      if (!indexName) continue

      const indexPath = `/services/data/indexes/${encodeURIComponent(indexName)}`

      // Capture current state for rollback
      const existing = await getEntityContent(baseUrl, auth, indexPath)
      if (existing) {
        const snapshot: Record<string, unknown> = { name: indexName }
        for (const key of ROLLBACK_KEYS) {
          if (existing[key] !== undefined) snapshot[key] = existing[key]
        }
        rollbackSnapshot.push(snapshot)
      }

      const payload = buildIndexPayload(fields, !existing)

      if (existing) {
        // Update existing index — Splunk rejects create-only args and `name` here
        await postForm(baseUrl, auth, indexPath, payload)
      } else {
        await postForm(baseUrl, auth, '/services/data/indexes', { name: indexName, ...payload })
        createdIndexes.push(indexName)
      }

      deployedIndexes.push(indexName)
    }

    return {
      success: true,
      message: `Deployed ${deployedIndexes.length} index(es): ${deployedIndexes.join(', ')}`,
      artifacts: { deployedIndexes, createdIndexes },
      rollbackData: { previousState: rollbackSnapshot, createdIndexes },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deployment failed after ${deployedIndexes.length} index(es): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedIndexes, createdIndexes, failedAt: canvas.sections[deployedIndexes.length]?.fields?.name },
      // Expose what already changed so a rollback can still run after a partial failure
      rollbackData: { previousState: rollbackSnapshot, createdIndexes },
    }
  }
}

/** Map canvas fields to Splunk REST parameters. */
function buildIndexPayload(
  fields: Record<string, unknown>,
  isCreate: boolean,
): Record<string, string> {
  const payload: Record<string, string> = {}

  if (typeof fields.maxDataSizeMB === 'number') {
    payload.maxTotalDataSizeMB = String(fields.maxDataSizeMB)
  }
  if (typeof fields.frozenTimeDays === 'number') {
    payload.frozenTimePeriodInSecs = String(fields.frozenTimeDays * 86400)
  }

  // Per-bucket size: auto | auto_high_volume | explicit MB
  const mode = fields.maxDataSizeMode as string | undefined
  if (mode === 'auto' || mode === 'auto_high_volume') {
    payload.maxDataSize = mode
  } else if (mode === 'custom' && typeof fields.maxDataSizeCustomMB === 'number') {
    payload.maxDataSize = String(fields.maxDataSizeCustomMB)
  }

  // Splunk always compresses rawdata; this selects the journal codec.
  if (fields.enableCompression === true) payload.journalCompression = 'zstd'

  if (typeof fields.coldToFrozenDir === 'string' && fields.coldToFrozenDir) {
    payload.coldToFrozenDir = fields.coldToFrozenDir
  }

  if (typeof fields.enableTsidxReduction === 'boolean') {
    payload.enableTsidxReduction = fields.enableTsidxReduction ? '1' : '0'
    if (fields.enableTsidxReduction && typeof fields.tsidxReductionPeriodDays === 'number') {
      payload.timePeriodInSecBeforeTsidxReduction = String(fields.tsidxReductionPeriodDays * 86400)
    }
  }

  if (isCreate) {
    for (const key of CREATE_ONLY_KEYS) {
      const value = fields[key]
      if (typeof value === 'string' && value) payload[key] = value
    }
  }

  return payload
}
