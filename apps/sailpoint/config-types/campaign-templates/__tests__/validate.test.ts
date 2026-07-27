import validate, { extractCampaignTemplateSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const goodCampaign = '{"name":"Cert","description":"d","type":"MANAGER"}'

describe('campaign-templates validate', () => {
  it('accepts a valid template', () => {
    const r = validate(ctxWith([{ name: 'Q1', fields: { name: 'Q1', description: 'quarterly', campaign: goodCampaign } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, description and campaign', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].description')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].campaign')).toBe(true)
  })

  it('requires a campaign type', () => {
    const r = validate(ctxWith([{ name: 'Q', fields: { name: 'Q', description: 'd', campaign: '{"name":"x"}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_campaign')).toBe(true)
  })
})

describe('extractCampaignTemplateSpecs', () => {
  it('stringifies an object campaign blob', () => {
    const specs = extractCampaignTemplateSpecs({
      items: [{ id: 'i1', name: 'Q', fields: { name: 'Q', description: 'd', campaign: { type: 'SEARCH' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].campaignRaw).toBe('{"type":"SEARCH"}')
  })
})
