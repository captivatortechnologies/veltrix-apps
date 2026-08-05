import validate, { extractReportConfigSpecs, reportConfigKey, parseJsonObject, parseNames } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-report-configs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-report-configs',
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

describe('InsightVM Report Configs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a scoped report configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Report',
          fields: {
            name: 'Monthly Audit',
            template_id: 'audit-report',
            format: 'pdf',
            site_names: 'DMZ\nCorp',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when no scope is declared', async () => {
    const result = await validate(
      makeCtx([{ name: 'Report', fields: { name: 'Everything', template_id: 'audit-report', format: 'pdf' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unscoped_report')).toBe(true)
  })

  it('rejects a missing name, template id and format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('template_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('format'))).toBe(true)
  })

  it('rejects invalid report_config_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x', template_id: 't', format: 'pdf', report_config_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a duplicate report name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Audit', template_id: 't1', format: 'pdf' } },
        { name: 'b', fields: { name: 'audit', template_id: 't2', format: 'html' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_report')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseNames('  ')).toEqual([])
    expect(parseNames('DMZ\n  Corp  \n\nLab')).toEqual(['DMZ', 'Corp', 'Lab'])
    expect(parseJsonObject('{"frequency":{"type":"none"}}').value).toEqual({ frequency: { type: 'none' } })
    const specs = extractReportConfigSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            name: '  Monthly Audit  ',
            template_id: '  audit-report  ',
            format: '  pdf  ',
            site_names: 'DMZ\nCorp',
            asset_group_names: 'Servers',
            tag_names: 'Prod',
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Monthly Audit')
    expect(specs[0].templateId).toBe('audit-report')
    expect(specs[0].format).toBe('pdf')
    expect(specs[0].siteNames).toEqual(['DMZ', 'Corp'])
    expect(specs[0].assetGroupNames).toEqual(['Servers'])
    expect(specs[0].tagNames).toEqual(['Prod'])
    expect(reportConfigKey(specs[0])).toBe('monthly audit')
  })
})
