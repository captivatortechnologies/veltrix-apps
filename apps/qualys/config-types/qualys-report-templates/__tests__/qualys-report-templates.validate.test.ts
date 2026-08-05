import validate, { isWellFormedXmlFragment, reportTemplateKey, reportTemplateTypeMeta } from '../validate'
import {
  cdata,
  reportTemplatePath,
  reportTemplateReturnId,
  reportTemplateWriteError,
  wrapReportTemplateXml,
} from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-report-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-report-templates',
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

describe('Qualys Report Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal report template (type + title only)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { template_type: 'scan', title: 'Executive Report' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an unsupported template type (e.g. dropped pciscan)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { template_type: 'pciscan', title: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects missing title', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { template_type: 'scan' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('rejects malformed settings XML', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { template_type: 'scan', title: 'x', settings_xml: '<TARGET><INFO key="a">1</INFO>' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_xml')).toBe(true)
  })

  it('accepts well-formed settings XML with CDATA content containing angle-bracket-like text', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: {
            template_type: 'scan',
            title: 'x',
            settings_xml: '<TARGET><INFO key="ips"><![CDATA[10.0.0.1]]></INFO></TARGET>',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate (type, title) pairs, allows same title across types', async () => {
    const dup = await validate(
      makeCtx([
        { name: 'a', fields: { template_type: 'scan', title: 'Weekly' } },
        { name: 'b', fields: { template_type: 'scan', title: 'weekly' } },
      ]),
    )
    expect(dup.valid).toBe(false)
    expect(dup.errors.some((e) => e.code === 'duplicate_report_template')).toBe(true)

    const crossType = await validate(
      makeCtx([
        { name: 'a', fields: { template_type: 'scan', title: 'Weekly' } },
        { name: 'b', fields: { template_type: 'patch', title: 'Weekly' } },
      ]),
    )
    expect(crossType.valid).toBe(true)
  })

  it('reportTemplateTypeMeta resolves the wrapper tag and list type per type', () => {
    expect(reportTemplateTypeMeta('scan')?.wrapperTag).toBe('SCANTEMPLATE')
    expect(reportTemplateTypeMeta('patch')?.wrapperTag).toBe('PATCHTEMPLATE')
    expect(reportTemplateTypeMeta('map')?.wrapperTag).toBe('MAPTEMPLATE')
    expect(reportTemplateTypeMeta('pciscan')).toBeUndefined()
  })

  it('reportTemplateKey namespaces by type and lowercases the title', () => {
    expect(reportTemplateKey({ templateType: 'scan', title: 'Weekly' })).toBe(reportTemplateKey({ templateType: 'scan', title: 'weekly' }))
    expect(reportTemplateKey({ templateType: 'scan', title: 'Weekly' }) === reportTemplateKey({ templateType: 'patch', title: 'Weekly' })).toBe(false)
  })

  describe('isWellFormedXmlFragment', () => {
    it('accepts empty input (settings are optional)', () => {
      expect(isWellFormedXmlFragment('')).toBe(true)
      expect(isWellFormedXmlFragment('   ')).toBe(true)
    })

    it('accepts properly nested tags', () => {
      expect(isWellFormedXmlFragment('<TARGET><INFO key="a">1</INFO><INFO key="b">2</INFO></TARGET>')).toBe(true)
    })

    it('rejects an unclosed tag', () => {
      expect(isWellFormedXmlFragment('<TARGET><INFO key="a">1</INFO>')).toBe(false)
    })

    it('rejects mismatched close tags', () => {
      expect(isWellFormedXmlFragment('<TARGET><INFO key="a">1</TARGET></INFO>')).toBe(false)
    })

    it('ignores angle-bracket-like content inside CDATA', () => {
      expect(isWellFormedXmlFragment('<INFO key="html"><![CDATA[<broken<tag]]></INFO>')).toBe(true)
    })
  })

  describe('deploy helpers', () => {
    it('reportTemplatePath maps to the per-type endpoint', () => {
      expect(reportTemplatePath('scan')).toBe('/api/2.0/fo/report/template/scan/')
      expect(reportTemplatePath('patch')).toBe('/api/2.0/fo/report/template/patch/')
      expect(reportTemplatePath('map')).toBe('/api/2.0/fo/report/template/map/')
    })

    it('cdata escapes an embedded "]]>" sequence', () => {
      expect(cdata('safe value')).toBe('<![CDATA[safe value]]>')
      expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>')
    })

    it('wrapReportTemplateXml builds the full envelope with title/owner and passes settings through verbatim', () => {
      const xml = wrapReportTemplateXml({
        sectionName: 's',
        templateType: 'scan',
        title: 'Weekly Exec',
        owner: 'acme_jk',
        settingsXml: '<TARGET><INFO key="scan_selection"><![CDATA[HostBased]]></INFO></TARGET>',
      })
      expect(xml).toBe(
        '<REPORTTEMPLATE><SCANTEMPLATE><TITLE><INFO key="title"><![CDATA[Weekly Exec]]></INFO>' +
          '<INFO key="owner"><![CDATA[acme_jk]]></INFO></TITLE>' +
          '<TARGET><INFO key="scan_selection"><![CDATA[HostBased]]></INFO></TARGET></SCANTEMPLATE></REPORTTEMPLATE>',
      )
    })

    it('wrapReportTemplateXml omits the owner INFO when owner is blank', () => {
      const xml = wrapReportTemplateXml({ sectionName: 's', templateType: 'patch', title: 'x', owner: '', settingsXml: '' })
      expect(xml).toBe('<REPORTTEMPLATE><PATCHTEMPLATE><TITLE><INFO key="title"><![CDATA[x]]></INFO></TITLE></PATCHTEMPLATE></REPORTTEMPLATE>')
    })

    it('reportTemplateWriteError treats a "Successfully" CODE as success (the opposite of every other classic-API call)', () => {
      const success = {
        status: 200,
        ok: true,
        body: '<SIMPLE_RETURN><RESPONSE><CODE>Scan Report Template(s) Created Successfully [89876]</CODE><TEXT></TEXT></RESPONSE></SIMPLE_RETURN>',
      }
      expect(reportTemplateWriteError(success)).toBeNull()
    })

    it('reportTemplateWriteError treats an empty or non-success CODE as failure', () => {
      const empty = { status: 200, ok: true, body: '<SIMPLE_RETURN><RESPONSE><TEXT></TEXT></RESPONSE></SIMPLE_RETURN>' }
      expect(reportTemplateWriteError(empty) === null).toBe(false)

      const failure = {
        status: 200,
        ok: true,
        body: '<SIMPLE_RETURN><RESPONSE><CODE>2001</CODE><TEXT>Invalid template_id</TEXT></RESPONSE></SIMPLE_RETURN>',
      }
      expect(reportTemplateWriteError(failure)).toBe('2001')
    })

    it('reportTemplateReturnId extracts the bracketed id from the success CODE message', () => {
      const xml = '<SIMPLE_RETURN><RESPONSE><CODE>Scan Report Template Updated Successfully [8209]</CODE></RESPONSE></SIMPLE_RETURN>'
      expect(reportTemplateReturnId(xml)).toBe('8209')
      expect(reportTemplateReturnId('<SIMPLE_RETURN><RESPONSE><TEXT></TEXT></RESPONSE></SIMPLE_RETURN>')).toBeNull()
    })
  })
})
