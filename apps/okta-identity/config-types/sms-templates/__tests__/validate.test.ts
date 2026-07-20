import validate, {
  buildSmsTemplateBody,
  extractSmsTemplateSpecs,
  parseTranslations,
  stripReadOnlySmsFields,
  MAX_NAME,
  MAX_TEMPLATE,
  SMS_TEMPLATE_TYPE,
} from '../validate'
import { type SmsTemplateRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'sms-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'sms-templates',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'sms-templates',
    items: sections,
    sections,
    snapshot: {},
  }
}

const BODY = 'Your ${org.name} verification code is ${code}'
const TRANSLATIONS = '{"es":"Tu codigo es ${code}","fr":"Votre code est ${code}"}'

describe('Okta SMS Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid template', async () => {
    const result = await validate(
      makeCtx([{ name: 'Tmpl', fields: { name: 'Custom Verify', type: 'SMS_VERIFY_CODE', template: BODY } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a template with translations', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Tmpl',
          fields: { name: 'Custom Verify', type: 'SMS_VERIFY_CODE', template: BODY, translationsJson: TRANSLATIONS },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'SMS_VERIFY_CODE', template: BODY } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 50 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(51), type: 'SMS_VERIFY_CODE', template: BODY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Type', template: BODY } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an unknown type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad Type', type: 'EMAIL_VERIFY', template: BODY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a missing template', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Body', type: 'SMS_VERIFY_CODE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('template'))).toBe(true)
  })

  it('rejects a template longer than 161 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Long Body', type: 'SMS_VERIFY_CODE', template: 'x'.repeat(162) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('template'))).toBe(true)
  })

  it('rejects malformed translations JSON', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Bad JSON', type: 'SMS_VERIFY_CODE', template: BODY, translationsJson: '{not json' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_translations')).toBe(true)
  })

  it('rejects translations that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Array Tr', type: 'SMS_VERIFY_CODE', template: BODY, translationsJson: '["a","b"]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_translations')).toBe(true)
  })

  it('rejects a translation with a non-string value', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Num Tr', type: 'SMS_VERIFY_CODE', template: BODY, translationsJson: '{"es":123}' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_translations')).toBe(true)
  })

  it('rejects a translation value longer than 161 characters', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Long Tr',
            type: 'SMS_VERIFY_CODE',
            template: BODY,
            translationsJson: JSON.stringify({ es: 'x'.repeat(162) }),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_translations')).toBe(true)
  })

  it('rejects a duplicate template name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Verify', type: 'SMS_VERIFY_CODE', template: BODY } },
        { name: 'sec2', fields: { name: 'verify', type: 'SMS_VERIFY_CODE', template: BODY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractSmsTemplateSpecs', () => {
  it('trims fields, upper-cases the type and drops a blank translations blob', () => {
    const specs = extractSmsTemplateSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: '  Custom Verify  ', type: '  sms_verify_code  ', template: '  Hi ${code}  ', translationsJson: '   ' },
        },
      ]),
    )
    expect(specs[0].name).toBe('Custom Verify')
    expect(specs[0].type).toBe('SMS_VERIFY_CODE')
    expect(specs[0].template).toBe('Hi ${code}')
    expect(specs[0].translationsJson).toBeUndefined()
  })
})

describe('parseTranslations', () => {
  it('parses a JSON object of string values', () => {
    expect(parseTranslations('{"es":"hola","fr":"bonjour"}')).toEqual({ es: 'hola', fr: 'bonjour' })
  })
  it('rejects a JSON array', () => {
    expect(parseTranslations('["a","b"]')).toBeNull()
  })
  it('rejects an object with a non-string value', () => {
    expect(parseTranslations('{"es":42}')).toBeNull()
  })
  it('rejects malformed JSON', () => {
    expect(parseTranslations('{nope')).toBeNull()
  })
})

describe('buildSmsTemplateBody', () => {
  it('builds the body and omits translations when the map is empty', () => {
    const body = buildSmsTemplateBody(
      { sectionName: 's', name: 'Verify', type: SMS_TEMPLATE_TYPE, template: BODY },
      {},
    )
    expect(body).toEqual({ name: 'Verify', type: SMS_TEMPLATE_TYPE, template: BODY })
  })

  it('includes translations when the map is non-empty', () => {
    const body = buildSmsTemplateBody(
      { sectionName: 's', name: 'Verify', type: SMS_TEMPLATE_TYPE, template: BODY },
      { es: 'Tu codigo es ${code}' },
    )
    expect(body).toEqual({
      name: 'Verify',
      type: SMS_TEMPLATE_TYPE,
      template: BODY,
      translations: { es: 'Tu codigo es ${code}' },
    })
  })
})

describe('stripReadOnlySmsFields', () => {
  it('removes id/created/lastUpdated/_links but keeps the body and translations', () => {
    const stripped = stripReadOnlySmsFields({
      id: 'cstabc',
      name: 'Verify',
      type: 'SMS_VERIFY_CODE',
      template: BODY,
      translations: { es: 'hola' },
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
    })
    expect(stripped).toEqual({
      name: 'Verify',
      type: 'SMS_VERIFY_CODE',
      template: BODY,
      translations: { es: 'hola' },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped._links).toBeUndefined()
  })
})

describe('constants', () => {
  it('exposes the Okta limits', () => {
    expect(MAX_NAME).toBe(50)
    expect(MAX_TEMPLATE).toBe(161)
    expect(SMS_TEMPLATE_TYPE).toBe('SMS_VERIFY_CODE')
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: SmsTemplateRollbackEntry | null = null
void _rollbackEntryType
