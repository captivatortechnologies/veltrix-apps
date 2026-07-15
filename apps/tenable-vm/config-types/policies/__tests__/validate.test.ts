import validate, { extractPolicySpecs, parseSettingsObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

/** A valid Tenable editor policy template uuid (standard 8-4-4-4-12 layout). */
const TEMPLATE_UUID = 'ad629e16-03b6-8c1d-cef6-ef8c9dd3c658'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'policies',
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

const VALID_SETTINGS = '{"acls":[{"permissions":0,"type":"default"}]}'

describe('Tenable VM Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'General', fields: { name: 'Weekly Prod Policy', templateUuid: TEMPLATE_UUID } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid policy with advanced settingsJson', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'General',
          fields: {
            name: 'Advanced Policy',
            description: 'Tuned scan policy',
            templateUuid: TEMPLATE_UUID,
            settingsJson: VALID_SETTINGS,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { templateUuid: TEMPLATE_UUID } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), templateUuid: TEMPLATE_UUID } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing template uuid', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'p1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('templateUuid'))).toBe(true)
  })

  it('rejects a malformed template uuid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', templateUuid: 'not-a-uuid' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uuid')).toBe(true)
  })

  it('rejects invalid (non-JSON) advanced settings', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', templateUuid: TEMPLATE_UUID, settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects advanced settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', templateUuid: TEMPLATE_UUID, settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects duplicate policy names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Nightly', templateUuid: TEMPLATE_UUID } },
        { name: 'sec2', fields: { name: 'nightly', templateUuid: TEMPLATE_UUID } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows two distinct policy names in one canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Policy A', templateUuid: TEMPLATE_UUID } },
        { name: 'sec2', fields: { name: 'Policy B', templateUuid: TEMPLATE_UUID } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('trims fields and drops empty optional values', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Weekly Prod Policy  ',
            templateUuid: `  ${TEMPLATE_UUID}  `,
            description: '  ',
            settingsJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Weekly Prod Policy')
    expect(specs[0].templateUuid).toBe(TEMPLATE_UUID)
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].settingsJson).toBeUndefined()
  })
})

describe('parseSettingsObject', () => {
  it('parses a JSON object', () => {
    expect(parseSettingsObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseSettingsObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseSettingsObject('{nope')).toBe(null)
  })
})
