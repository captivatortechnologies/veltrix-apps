import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Apps Canvas',
      toolType: 'splunk-cloud',
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

/** A minimal private add-on that passes every Cloud rule. */
const validApp = {
  name: 'TA_acme',
  label: 'Acme Add-on',
  version: '1.0.0',
  author: 'Veltrix',
  description: 'Parses Acme firewall events',
  visibility: 'app',
  appFiles: [
    { path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' },
  ],
}

const withFiles = (files: Array<{ path: string; content: string }>) => ({
  ...validApp,
  appFiles: files,
})

describe('Splunk Cloud Apps Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a Cloud-clean private add-on', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validApp }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('falls back to the configuration name when no app id is given', async () => {
    // The configuration IS the app, so a blank App ID is not an error — it is
    // derived from the configuration's own name.
    const ctx = makeCtx([{ name: 'sec1', fields: { ...validApp, name: '' } }])
    ctx.canvas.name = 'Acme SOC Add-on'

    const result = await validate(ctx)

    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(false)
  })

  it('rejects a missing app id only when the configuration name yields none', async () => {
    const ctx = makeCtx([{ name: 'sec1', fields: { ...validApp, name: '' } }])
    ctx.canvas.name = '!!!'

    const result = await validate(ctx)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects an invalid app id format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, name: 'bad app!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('detects duplicate app ids', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validApp },
        { name: 'sec2', fields: validApp },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('requires authored files — there is no other Cloud install route', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, appFiles: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.appFiles') && e.code === 'required')).toBe(true)
  })

  it('rejects a version that is not 3-part semver', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, version: '1.0' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  // --- Cloud rules that are ERRORS here (Enterprise treats several as warnings) ---

  it('rejects indexes.conf — Cloud apps must REFERENCE an index, never create one', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' },
            {
              path: 'default/indexes.conf',
              content: '[acme_events]\nhomePath = $SPLUNK_DB/acme/db\n',
            },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'indexes_conf_forbidden')).toBe(true)
  })

  it('rejects outputs.conf — it is on the Splunk Cloud deny list', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/outputs.conf', content: '[tcpout]\ndefaultGroup = idx\n' },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'cloud_denied_conf')).toBe(true)
  })

  it('rejects a bare [http] stanza — it reconfigures the global HEC input', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/inputs.conf', content: '[http]\ndisabled = 0\nindex = acme\n' },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'bare_http_stanza')).toBe(true)
  })

  it('accepts a NAMED HEC token stanza', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            {
              path: 'default/inputs.conf',
              content: '[http://acme_events]\ndisabled = 0\nindex = acme_events\n',
            },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a banned input stanza (raw TCP)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/inputs.conf', content: '[tcp://5514]\nindex = acme_events\n' },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'cloud_banned_input')).toBe(true)
  })

  it('rejects a real-time saved search', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            {
              path: 'default/savedsearches.conf',
              content: '[Acme RT]\nsearch = index=acme_events\ndispatch.earliest_time = rt-5m\n',
            },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'realtime_search')).toBe(true)
  })

  it('rejects a cron more frequent than every 5 minutes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            {
              path: 'default/savedsearches.conf',
              content: '[Acme]\nsearch = index=acme_events\ncron_schedule = */2 * * * *\n',
            },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'cron_too_frequent')).toBe(true)
  })

  it('rejects index=* in a saved search', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            {
              path: 'default/savedsearches.conf',
              content: '[Acme]\nsearch = index=* error\ncron_schedule = 0 * * * *\n',
            },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'index_wildcard')).toBe(true)
  })

  it('rejects write access that omits sc_admin (the Cloud administrator role)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validApp, writeRoles: ['admin'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_sc_admin')).toBe(true)
  })

  it('rejects packaging local/ — it is the user-owned override layer', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' },
            { path: 'local/props.conf', content: '[acme:json]\nKV_MODE = none\n' },
          ]),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'local_in_package')).toBe(true)
  })

  it('rejects an unsafe file path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: withFiles([{ path: '../../etc/passwd', content: 'x' }]) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects a package with no conf beyond the generated app.conf', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: withFiles([{ path: 'bin/run.py', content: 'print(1)\n' }]) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_conf_files')).toBe(true)
  })

  it('warns that bin/ scripts draw AppInspect manual checks', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' },
            { path: 'bin/collect.py', content: 'print(1)\n' },
          ]),
        },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'bin_scripts_vetting')).toBe(true)
  })

  it('warns when a modular input ships no README/inputs.conf.spec', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: withFiles([
            { path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' },
            {
              path: 'default/inputs.conf',
              content: '[acme_poller://prod]\ninterval = 300\nindex = acme_events\n',
            },
            { path: 'bin/acme_poller.py', content: 'print(1)\n' },
          ]),
        },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'missing_inputs_spec')).toBe(true)
  })

  it('does not touch the network', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('validate must not make network calls')
    }) as typeof fetch
    try {
      const result = await validate(makeCtx([{ name: 'sec1', fields: validApp }]))
      expect(result.valid).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})
