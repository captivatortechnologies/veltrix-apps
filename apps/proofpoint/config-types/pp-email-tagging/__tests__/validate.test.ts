import validate, { extractEmailTaggingSpec, buildEmailTaggingBody, specFromBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-email-tagging',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-email-tagging',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Proofpoint Email Tagging Validate Handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates the all-disabled default configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Email Tagging Settings', fields: {} }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects more than one declared item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: {} },
        { name: 'b', fields: {} },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('rejects an enabled custom banner with no text', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { banner_enabled: true, banner_content: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'banner_content_required')).toBe(true)
  })

  it('rejects an enabled subject tag with no text', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { subject_tag_enabled: true, subject_tag_content: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'subject_tag_content_required')).toBe(true)
  })

  it('accepts a fully configured warning + subject tag setup', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: {
            warning_tags_enabled: true,
            warning_tag_dmarc_failure: true,
            banner_enabled: true,
            banner_content: 'This message failed authentication checks.',
            subject_tag_enabled: true,
            subject_tag_content: '[External]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when a sub-toggle is enabled while warning_tags_enabled is off', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { warning_tags_enabled: false, warning_tag_dmarc_failure: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'parent_disabled')).toBe(true)
  })

  it('extractEmailTaggingSpec applies documented Essentials defaults', () => {
    const spec = extractEmailTaggingSpec(makeCtx([{ name: 'a', fields: {} }]).canvas)
    expect(spec.warningTagsEnabled).toBe(false)
    expect(spec.subjectTagEnabled).toBe(false)
    expect(spec.subjectTagContent).toBe('[External]')
  })

  it('buildEmailTaggingBody nests the flat spec into the EmailTaggingPresenter wire shape', () => {
    const spec = extractEmailTaggingSpec(
      makeCtx([{ name: 'a', fields: { warning_tags_enabled: true, warning_tag_geo_ip_failure: true, banner_enabled: true, banner_content: 'Careful.' } }])
        .canvas,
    )
    const body = buildEmailTaggingBody(spec)
    expect(body.email_warning_tags.is_enabled).toBe(true)
    expect(body.email_warning_tags.warning_tags.geo_ip_failure).toBe(true)
    expect(body.email_warning_tags.warning_tags.dmarc_failure).toBe(false)
    expect(body.email_warning_tags.additional_banner_content).toEqual({ is_enabled: true, content: 'Careful.' })
    expect(body.email_subject_tags).toEqual({ is_enabled: false, content: '[External]' })
  })

  it('specFromBody round-trips buildEmailTaggingBody', () => {
    const spec = extractEmailTaggingSpec(
      makeCtx([{ name: 'a', fields: { warning_tags_enabled: true, learn_more_enabled: true, subject_tag_enabled: true } }]).canvas,
    )
    const roundTripped = specFromBody(buildEmailTaggingBody(spec))
    expect(roundTripped).toEqual(spec)
  })

  it('specFromBody tolerates a missing nested object', () => {
    const spec = specFromBody({} as never)
    expect(spec.warningTagsEnabled).toBe(false)
    expect(spec.subjectTagContent).toBe('')
  })
})
