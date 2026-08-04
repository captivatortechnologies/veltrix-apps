import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials email-tagging constraints --------------------------
//
// Organization-wide singleton at a dedicated GET/PUT sub-resource:
//   /orgs/{org}/email-tagging
// The API's EmailTaggingPresenter is a nested object (email_warning_tags.{...},
// email_subject_tags.{...}); this config type flattens every leaf into its own
// canvas field (same "flatten a fixed, finite schema" approach as Auth0's MFA
// factors) so nothing is hidden behind an opaque JSON blob. See the Essentials
// Interface API OpenAPI document
// (https://{stack}.proofpointessentials.com/apidocs/apidocs/docs), tag
// "email tagging", schema EmailTaggingPresenter.

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export interface EmailTaggingSpec {
  warningTagsEnabled: boolean
  infoTagExternalSender: boolean
  warningTagDmarcFailure: boolean
  warningTagDomainAgeFailure: boolean
  warningTagGeoIpFailure: boolean
  learnMoreEnabled: boolean
  learnMoreActionEnabled: boolean
  bannerEnabled: boolean
  bannerContent: string
  subjectTagEnabled: boolean
  subjectTagContent: string
}

/** The singleton item's fields, or field defaults when no item is declared. */
export function extractEmailTaggingSpec(canvas: CanvasSnapshot): EmailTaggingSpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}
  return {
    warningTagsEnabled: readBool(fields.warning_tags_enabled, false),
    infoTagExternalSender: readBool(fields.info_tag_external_sender, false),
    warningTagDmarcFailure: readBool(fields.warning_tag_dmarc_failure, false),
    warningTagDomainAgeFailure: readBool(fields.warning_tag_domain_age_failure, false),
    warningTagGeoIpFailure: readBool(fields.warning_tag_geo_ip_failure, false),
    learnMoreEnabled: readBool(fields.learn_more_enabled, false),
    learnMoreActionEnabled: readBool(fields.learn_more_action_enabled, false),
    bannerEnabled: readBool(fields.banner_enabled, false),
    bannerContent: readString(fields.banner_content),
    subjectTagEnabled: readBool(fields.subject_tag_enabled, false),
    subjectTagContent: readString(fields.subject_tag_content, '[External]'),
  }
}

/** The API's nested EmailTaggingPresenter shape. */
export interface EmailTaggingBody {
  email_warning_tags: {
    is_enabled: boolean
    info_tags: { external_sender: boolean }
    warning_tags: { dmarc_failure: boolean; domain_age_failure: boolean; geo_ip_failure: boolean }
    learn_more: { is_enabled: boolean; is_action_enabled: boolean }
    additional_banner_content: { is_enabled: boolean; content: string }
  }
  email_subject_tags: { is_enabled: boolean; content: string }
}

/** Build the PUT request body (EmailTaggingPresenter shape) from a declared spec. */
export function buildEmailTaggingBody(spec: EmailTaggingSpec): EmailTaggingBody {
  return {
    email_warning_tags: {
      is_enabled: spec.warningTagsEnabled,
      info_tags: { external_sender: spec.infoTagExternalSender },
      warning_tags: {
        dmarc_failure: spec.warningTagDmarcFailure,
        domain_age_failure: spec.warningTagDomainAgeFailure,
        geo_ip_failure: spec.warningTagGeoIpFailure,
      },
      learn_more: { is_enabled: spec.learnMoreEnabled, is_action_enabled: spec.learnMoreActionEnabled },
      additional_banner_content: { is_enabled: spec.bannerEnabled, content: spec.bannerContent },
    },
    email_subject_tags: { is_enabled: spec.subjectTagEnabled, content: spec.subjectTagContent },
  }
}

/** Flatten a live EmailTaggingPresenter response into the same spec shape declared above. */
export function specFromBody(body: EmailTaggingBody): EmailTaggingSpec {
  const wt = body.email_warning_tags ?? ({} as EmailTaggingBody['email_warning_tags'])
  const st = body.email_subject_tags ?? ({} as EmailTaggingBody['email_subject_tags'])
  return {
    warningTagsEnabled: !!wt.is_enabled,
    infoTagExternalSender: !!wt.info_tags?.external_sender,
    warningTagDmarcFailure: !!wt.warning_tags?.dmarc_failure,
    warningTagDomainAgeFailure: !!wt.warning_tags?.domain_age_failure,
    warningTagGeoIpFailure: !!wt.warning_tags?.geo_ip_failure,
    learnMoreEnabled: !!wt.learn_more?.is_enabled,
    learnMoreActionEnabled: !!wt.learn_more?.is_action_enabled,
    bannerEnabled: !!wt.additional_banner_content?.is_enabled,
    bannerContent: wt.additional_banner_content?.content ?? '',
    subjectTagEnabled: !!st.is_enabled,
    subjectTagContent: st.content ?? '',
  }
}

// --- Email-tagging I/O (shared by deploy / rollback / healthCheck / drift) ----

/** Read the org's current email-tagging settings; throws on a non-OK response. */
export async function getEmailTagging(client: PPClient): Promise<EmailTaggingBody> {
  const res = await client.request('GET', `${client.orgPath}/email-tagging`)
  if (!res.ok) throw new Error(`Failed to read email-tagging settings: ${ppErrorMessage(res)}`)
  return asObject(res.body) as unknown as EmailTaggingBody
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the Email Tagging Settings singleton: at most one declared item; a
 * custom banner or subject tag that is enabled must have non-empty text; and a
 * warning when a sub-toggle is enabled while its parent (warning tags) is
 * disabled — Essentials will not act on it until the parent is enabled too.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the Email Tagging Settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({ field: 'sections', message: 'Email Tagging Settings is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  const spec = extractEmailTaggingSpec(ctx.canvas)
  const prefix = sections[0].name

  if (spec.bannerEnabled && !spec.bannerContent) {
    errors.push({ field: `${prefix}.banner_content`, message: 'Custom banner text is required when "Add a custom banner" is enabled', code: 'banner_content_required' })
  }
  if (spec.subjectTagEnabled && !spec.subjectTagContent) {
    errors.push({ field: `${prefix}.subject_tag_content`, message: 'Subject tag text is required when "Enable subject tag" is enabled', code: 'subject_tag_content_required' })
  }

  if (!spec.warningTagsEnabled) {
    const activeSubToggles: string[] = []
    if (spec.infoTagExternalSender) activeSubToggles.push('info_tag_external_sender')
    if (spec.warningTagDmarcFailure) activeSubToggles.push('warning_tag_dmarc_failure')
    if (spec.warningTagDomainAgeFailure) activeSubToggles.push('warning_tag_domain_age_failure')
    if (spec.warningTagGeoIpFailure) activeSubToggles.push('warning_tag_geo_ip_failure')
    if (spec.learnMoreEnabled) activeSubToggles.push('learn_more_enabled')
    if (spec.bannerEnabled) activeSubToggles.push('banner_enabled')
    if (activeSubToggles.length > 0) {
      warnings.push({
        field: `${prefix}.warning_tags_enabled`,
        message: `Warning tags are disabled, so these enabled conditions have no effect: ${activeSubToggles.join(', ')}`,
        code: 'parent_disabled',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
