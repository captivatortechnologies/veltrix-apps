import validate, {
  extractAccountSettingsSpecs,
  buildSettingsParams,
  serializeLiveSetting,
  SETTING_FIELDS,
} from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

function boolDef() {
  return SETTING_FIELDS.find((d) => d.key === 'password_requires_upper_alpha')!
}
function intDef() {
  return SETTING_FIELDS.find((d) => d.key === 'lockout_threshold')!
}

describe('account-settings validate', () => {
  it('accepts a valid partial configuration', () => {
    const r = validate(
      ctxWith([{ name: 'Settings', fields: { lockout_threshold: '5', password_requires_upper_alpha: 'true', helpdesk_bypass: 'deny' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('warns when nothing is declared', () => {
    const r = validate(ctxWith([{ name: 'Settings', fields: {} }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_settings')).toBe(true)
  })

  it('rejects a non-integer number field', () => {
    const r = validate(ctxWith([{ name: 'Settings', fields: { lockout_threshold: '5.5' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects an out-of-enum value', () => {
    const r = validate(ctxWith([{ name: 'Settings', fields: { helpdesk_bypass: 'maybe' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects more than one configuration (singleton)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { lockout_threshold: '1' } },
        { name: 'b', fields: { lockout_threshold: '2' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })
})

describe('extractAccountSettingsSpecs', () => {
  it('only includes fields the operator set', () => {
    const specs = extractAccountSettingsSpecs({
      items: [{ id: 'i1', name: 'S', fields: { lockout_threshold: '5', timezone: '' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].values).toEqual({ lockout_threshold: '5' })
  })
})

describe('buildSettingsParams', () => {
  it('serializes booleans to 1/0 and passes numbers through', () => {
    const params = buildSettingsParams({
      sectionName: 's',
      values: { lockout_threshold: '5', password_requires_upper_alpha: 'true', password_requires_numeric: 'false' },
    })
    expect(params).toEqual({ lockout_threshold: '5', password_requires_upper_alpha: '1', password_requires_numeric: '0' })
  })
})

describe('serializeLiveSetting', () => {
  it('maps live booleans and numbers to wire strings', () => {
    expect(serializeLiveSetting(boolDef(), true)).toBe('1')
    expect(serializeLiveSetting(boolDef(), false)).toBe('0')
    expect(serializeLiveSetting(intDef(), 5)).toBe('5')
  })
})
