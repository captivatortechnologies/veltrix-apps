import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { diffAttackTypeSettings, readLiveAttackTypeSettings } from '../lib/attackTypeSettings'
import { extractParameterProtectionSpec, getParameterProtection } from './validate'

const BOOL_FIELDS = [
  ['enabled', 'enabled'],
  ['base64_decode_parameter_value', 'base64DecodeParameterValue'],
  ['validate_parameter_name', 'validateParameterName'],
] as const

const NUMBER_FIELDS = [
  ['maximum_parameter_value_length', 'maximumParameterValueLength'],
  ['maximum_instances', 'maximumInstances'],
  ['maximum_upload_file_size', 'maximumUploadFileSize'],
] as const

const STRING_FIELDS = [
  ['denied_metacharacters', 'deniedMetacharacters'],
  ['allowed_file_upload_types', 'allowedFileUploadTypes'],
] as const

const LIST_FIELDS = [
  ['file_upload_extensions', 'fileUploadExtensions'],
  ['file_upload_mime_types', 'fileUploadMimeTypes'],
  ['ignore_parameters', 'ignoreParameters'],
  ['exception_patterns', 'exceptionPatterns'],
] as const

/** Detect drift between the deployed Parameter Protection object and the live Application. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const sections = ctx.deployedConfig.sections ?? []
  if (sections.length === 0) return { hasDrift: false, diffs: [] }
  const spec = extractParameterProtectionSpec(ctx.deployedConfig)

  try {
    const live = await getParameterProtection(client, appName)
    const liveRecord = live as Record<string, unknown>
    const specRecord = spec as unknown as Record<string, unknown>

    for (const [field, key] of BOOL_FIELDS) {
      const liveVal = liveRecord[field]
      const expected = specRecord[key]
      if ((liveVal ?? false) !== expected) {
        diffs.push({ field, expected, actual: liveVal ?? false, severity: field === 'enabled' ? 'critical' : 'warning' })
      }
    }

    for (const [field, key] of NUMBER_FIELDS) {
      const liveVal = liveRecord[field]
      const expected = specRecord[key]
      if ((liveVal ?? null) !== expected) {
        diffs.push({ field, expected, actual: liveVal ?? 'not set', severity: 'warning' })
      }
    }

    for (const [field, key] of STRING_FIELDS) {
      const liveVal = (liveRecord[field] as string | undefined) ?? ''
      const expected = specRecord[key] as string
      if (liveVal !== expected) {
        diffs.push({ field, expected: expected || 'not set', actual: liveVal || 'not set', severity: 'warning' })
      }
    }

    for (const [field, key] of LIST_FIELDS) {
      const liveList = [...((liveRecord[field] as string[] | undefined) ?? [])].sort()
      const expectedList = [...((specRecord[key] as string[] | undefined) ?? [])].sort()
      if (JSON.stringify(liveList) !== JSON.stringify(expectedList)) {
        diffs.push({
          field,
          expected: expectedList.join(', ') || 'none',
          actual: liveList.join(', ') || 'none',
          severity: 'warning',
        })
      }
    }

    diffAttackTypeSettings(spec.attackTypes, readLiveAttackTypeSettings(liveRecord), diffs)
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
