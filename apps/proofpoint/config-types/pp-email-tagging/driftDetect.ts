import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractEmailTaggingSpec, getEmailTagging, specFromBody } from './validate'

/**
 * Detect drift between the deployed Email Tagging Settings and the live org:
 * re-reads the settings and diffs every declared leaf field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const sections = ctx.deployedConfig.sections ?? []
  if (sections.length === 0) return { hasDrift: false, diffs: [] }
  const spec = extractEmailTaggingSpec(ctx.deployedConfig)

  try {
    const live = specFromBody(await getEmailTagging(client))

    const fields: Array<[string, keyof typeof spec]> = [
      ['warning_tags_enabled', 'warningTagsEnabled'],
      ['info_tag_external_sender', 'infoTagExternalSender'],
      ['warning_tag_dmarc_failure', 'warningTagDmarcFailure'],
      ['warning_tag_domain_age_failure', 'warningTagDomainAgeFailure'],
      ['warning_tag_geo_ip_failure', 'warningTagGeoIpFailure'],
      ['learn_more_enabled', 'learnMoreEnabled'],
      ['learn_more_action_enabled', 'learnMoreActionEnabled'],
      ['banner_enabled', 'bannerEnabled'],
      ['banner_content', 'bannerContent'],
      ['subject_tag_enabled', 'subjectTagEnabled'],
      ['subject_tag_content', 'subjectTagContent'],
    ]

    for (const [wireName, key] of fields) {
      if (spec[key] !== live[key]) {
        diffs.push({ field: wireName, expected: spec[key], actual: live[key], severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'proofpoint',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
