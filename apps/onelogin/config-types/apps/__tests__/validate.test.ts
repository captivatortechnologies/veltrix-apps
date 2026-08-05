import validate, { extractAppSpecs, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'apps',
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

describe('OneLogin Apps Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid app (name + connectorId only)', async () => {
    const result = await validate(makeCtx([{ name: 'App', fields: { name: 'Salesforce', connectorId: 50534 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid app with every field set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'App',
          fields: {
            name: 'Salesforce',
            connectorId: 50534,
            description: 'Sales team SSO',
            notes: 'internal note',
            visible: true,
            allowAssumedSignin: false,
            policyId: 12,
            tabId: 34,
            provisioningEnabled: true,
            configurationJson: '{"signature_algorithm":"SHA-256"}',
            parametersJson: '{"saml_username":{"user_attribute_mappings":"samaccountname"}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { connectorId: 1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), connectorId: 1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('accepts a name exactly at the 255 character cap', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(255), connectorId: 1 } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate app name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Salesforce', connectorId: 1 } },
        { name: 'sec2', fields: { name: 'Salesforce', connectorId: 2 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_app')).toBe(true)
  })

  it('rejects a missing connectorId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Salesforce' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('connectorId'))).toBe(true)
  })

  it('rejects a non-integer connectorId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 1.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_connector_id')).toBe(true)
  })

  it('rejects a zero/negative connectorId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_connector_id')).toBe(true)
  })

  it('rejects a negative policyId/tabId', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 1, policyId: -1, tabId: -2 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_id')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_tab_id')).toBe(true)
  })

  it('rejects malformed configurationJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 1, configurationJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_configuration')).toBe(true)
  })

  it('rejects a configurationJson array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 1, configurationJson: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_configuration')).toBe(true)
  })

  it('rejects malformed parametersJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Salesforce', connectorId: 1, parametersJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_parameters')).toBe(true)
  })
})

describe('extractAppSpecs', () => {
  it('trims fields, applies defaults and normalizes blanks to undefined', () => {
    const specs = extractAppSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'apps',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Salesforce  ',
            connectorId: '50534',
            description: '  ',
            notes: undefined,
            visible: false,
            allowAssumedSignin: true,
            policyId: 12,
            tabId: undefined,
            provisioningEnabled: true,
            configurationJson: '  {"a":1}  ',
            parametersJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Salesforce')
    expect(specs[0].connectorId).toBe(50534)
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].notes).toBeUndefined()
    expect(specs[0].visible).toBe(false)
    expect(specs[0].allowAssumedSignin).toBe(true)
    expect(specs[0].policyId).toBe(12)
    expect(specs[0].tabId).toBeUndefined()
    expect(specs[0].provisioningEnabled).toBe(true)
    expect(specs[0].configurationJson).toBe('{"a":1}')
    expect(specs[0].parametersJson).toBeUndefined()
  })

  it('defaults visible to true and other booleans to false when absent', () => {
    const specs = extractAppSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'apps',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'App', connectorId: 1 } }],
      snapshot: {},
    })
    expect(specs[0].visible).toBe(true)
    expect(specs[0].allowAssumedSignin).toBe(false)
    expect(specs[0].provisioningEnabled).toBe(false)
  })
})

describe('parseJsonObject', () => {
  it('parses a valid JSON object', () => {
    expect(parseJsonObject('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' })
  })
  it('returns null for malformed JSON', () => {
    expect(parseJsonObject('{not json')).toBeNull()
  })
  it('returns null for a JSON array', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull()
  })
  it('returns null for a JSON primitive', () => {
    expect(parseJsonObject('"just a string"')).toBeNull()
    expect(parseJsonObject('42')).toBeNull()
  })
  it('accepts an empty JSON object', () => {
    expect(parseJsonObject('{}')).toEqual({})
  })
})
