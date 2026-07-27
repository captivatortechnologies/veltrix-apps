import validate, { parseTemplateConfig, extractNotificationTemplateSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const CFG = '{"open":[{"fieldName":"summary","value":"x"}]}'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('notification-templates validate', () => {
  it('accepts a valid email template', () => {
    const r = validate(ctxWith([{ name: 'Ops', fields: { name: 'Ops', integrationType: 'email', templateConfig: CFG } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { integrationType: 'email', templateConfig: CFG } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects an unknown integration type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', integrationType: 'pigeon', templateConfig: CFG } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires an integrationId for jira', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', integrationType: 'jira', templateConfig: CFG } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.integrationId'))).toBe(true)
  })

  it('rejects invalid template config JSON', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', integrationType: 'email', templateConfig: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_template_config')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', integrationType: 'email', templateConfig: CFG } },
        { name: 'Dup', fields: { name: 'Dup', integrationType: 'email', templateConfig: CFG } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseTemplateConfig', () => {
  it('parses a JSON object string', () => {
    expect(parseTemplateConfig(CFG).templateConfig).toEqual({ open: [{ fieldName: 'summary', value: 'x' }] })
  })

  it('flags an array JSON value', () => {
    expect(parseTemplateConfig('[1,2]').templateConfigError).toBe('Template config must be a JSON object')
  })
})

describe('extractNotificationTemplateSpecs', () => {
  it('defaults enabled to true', () => {
    const specs = extractNotificationTemplateSpecs({
      items: [{ id: 'i1', name: 'T', fields: { name: 'T', integrationType: 'email', templateConfig: CFG } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enabled).toBe(true)
  })
})
