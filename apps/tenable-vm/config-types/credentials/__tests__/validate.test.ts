import validate, { extractCredentialSpecs, parseSettingsObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'credentials',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'credentials',
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

const VALID_SETTINGS = '{"auth_method":"password","username":"svc","password":"s3cret"}'

describe('Tenable Credentials Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid credential', async () => {
    const result = await validate(
      makeCtx([{ name: 'Credential', fields: { name: 'Prod SSH', type: 'SSH', settingsJson: VALID_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'SSH', settingsJson: VALID_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Prod SSH', settingsJson: VALID_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects missing settings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Prod SSH', type: 'SSH' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('settingsJson'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), type: 'SSH', settingsJson: VALID_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('name'))).toBe(true)
  })

  it('rejects settings that are not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Prod SSH', type: 'SSH', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Prod SSH', type: 'SSH', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects a duplicate credential name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Prod SSH', type: 'SSH', settingsJson: VALID_SETTINGS } },
        { name: 'sec2', fields: { name: 'Prod SSH', type: 'Windows', settingsJson: VALID_SETTINGS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_credential')).toBe(true)
  })

  it('allows distinct credential names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Prod SSH', type: 'SSH', settingsJson: VALID_SETTINGS } },
        { name: 'sec2', fields: { name: 'Prod Windows', type: 'Windows', settingsJson: VALID_SETTINGS } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractCredentialSpecs', () => {
  it('trims fields and drops empty optional values', () => {
    const specs = extractCredentialSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'credentials',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Prod SSH  ',
            type: '  SSH  ',
            description: '  ',
            settingsJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Prod SSH')
    expect(specs[0].type).toBe('SSH')
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
