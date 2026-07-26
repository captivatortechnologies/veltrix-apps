import validate, { extractOptionProfileSpecs, optionProfileKey, readBool } from '../validate'
import { buildCreateParams, buildUpdateParams, parseOptionProfileBlock, parseFlag } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const SETTINGS =
  '{"scan_tcp_ports":"standard","scan_udp_ports":"standard","scan_overall_performance":"normal","vulnerability_detection":"complete"}'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-option-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-option-profiles',
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

describe('Qualys Option Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal option profile (title only)', async () => {
    const result = await validate(makeCtx([{ name: 'OP', fields: { title: 'Initial Options' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a full option profile', async () => {
    const result = await validate(
      makeCtx([{ name: 'OP', fields: { title: 'Prod Scan', global: true, is_default: false, settings_json: SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { settings_json: SETTINGS } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('rejects malformed settings_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', settings_json: '{bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an unsupported enum value in settings_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { title: 'x', settings_json: '{"scan_tcp_ports":"everything"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('accepts an empty settings_json (allowEmpty)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', settings_json: '   ' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate titles case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { title: 'Prod' } },
        { name: 'b', fields: { title: 'prod' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_option_profile')).toBe(true)
  })

  it('readBool coerces and optionProfileKey lowercases', () => {
    expect(readBool('1', false)).toBe(true)
    expect(optionProfileKey({ title: 'Prod Scan' })).toBe(optionProfileKey({ title: 'prod scan' }))
  })

  it('build params flatten settings and encode global/default as 1/0', () => {
    const spec = extractOptionProfileSpecs(
      makeCtx([{ name: 't', fields: { title: 'Prod Scan', global: true, is_default: true, settings_json: SETTINGS } }])
        .canvas,
    )[0]

    const create = buildCreateParams(spec)
    expect(create.action).toBe('create')
    expect(create.title).toBe('Prod Scan')
    expect(create.global).toBe(1)
    expect(create.default).toBe(1)
    expect(create.scan_tcp_ports).toBe('standard')
    expect(create.vulnerability_detection).toBe('complete')

    const update = buildUpdateParams(spec, '4561')
    expect(update.action).toBe('update')
    expect(update.id).toBe('4561')
    expect(update.default).toBe(1)
  })

  it('parseOptionProfileBlock reads id/title/global/default from BASIC_INFO', () => {
    const block =
      '<BASIC_INFO><ID>4561</ID><GROUP_NAME>Prod Scan</GROUP_NAME><GROUP_TYPE>user</GROUP_TYPE>' +
      '<IS_GLOBAL>1</IS_GLOBAL><IS_DEFAULT>0</IS_DEFAULT></BASIC_INFO><SCAN></SCAN>'
    const p = parseOptionProfileBlock(block)
    expect(p.id).toBe('4561')
    expect(p.title).toBe('Prod Scan')
    expect(p.global).toBe(true)
    expect(p.isDefault).toBe(false)
  })

  it('parseFlag accepts 1/0 and Yes/No', () => {
    expect(parseFlag('1')).toBe(true)
    expect(parseFlag('Yes')).toBe(true)
    expect(parseFlag('0')).toBe(false)
    expect(parseFlag('No')).toBe(false)
  })
})
