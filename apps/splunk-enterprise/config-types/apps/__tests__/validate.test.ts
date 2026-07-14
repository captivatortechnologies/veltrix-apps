import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Apps Canvas',
      toolType: 'splunk',
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

const validApp = {
  name: 'Splunk_TA_nix',
  source: 'splunkbase',
  sourceRef: '833',
  version: '9.1.0',
  targetTypes: ['search-head'],
  visibility: 'app',
  state: 'enabled',
  upgradePolicy: 'manual',
}

describe('Splunk Apps Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified app', async () => {
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

  it('rejects invalid app id format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, name: 'bad app!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects app id exceeding max length', async () => {
    const longName = 'a'.repeat(129)
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, name: longName } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('detects duplicate app ids', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...validApp, name: 'dup_app' } },
        { name: 'sec2', fields: { ...validApp, name: 'dup_app' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('requires a source reference', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, sourceRef: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.sourceRef'))).toBe(true)
  })

  it('rejects a non-numeric Splunkbase reference', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, source: 'splunkbase', sourceRef: 'not-an-id' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.sourceRef'))).toBe(true)
  })

  it('rejects a non-https package URL', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, source: 'url', sourceRef: 'http://example.com/app.tgz' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.sourceRef'))).toBe(true)
  })

  it('accepts an https package URL', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, source: 'url', sourceRef: 'https://example.com/app.tgz' } }]))
    expect(result.valid).toBe(true)
  })

  it('accepts a local package path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, source: 'local', sourceRef: '/opt/pkgs/app.spl' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid source', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, source: 'ftp' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value' && e.field.endsWith('.source'))).toBe(true)
  })

  it('rejects invalid visibility, state and upgrade policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validApp, visibility: 'private', state: 'paused', upgradePolicy: 'nightly' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.visibility') && e.code === 'invalid_value')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.state') && e.code === 'invalid_value')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.upgradePolicy') && e.code === 'invalid_value')).toBe(true)
  })

  it('warns on Splunkbase source (requires Splunkbase auth)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validApp }]))
    expect(result.warnings.some((w) => w.code === 'splunkbase_auth')).toBe(true)
  })

  it('warns on global sharing', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, visibility: 'global' } }]))
    expect(result.warnings.some((w) => w.code === 'global_sharing')).toBe(true)
  })

  it('warns when a manual upgrade policy has no pinned version', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, upgradePolicy: 'manual', version: '' } }]))
    expect(result.warnings.some((w) => w.code === 'no_version_pin')).toBe(true)
  })

  it('warns when no target types are set', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validApp, targetTypes: [] } }]))
    expect(result.warnings.some((w) => w.code === 'no_target_types')).toBe(true)
  })

  // --- Inline (author files) source ---------------------------------------

  // A label (5-80 chars) and a 3-part version are required by Splunk itself:
  // app.conf must carry [ui] label and matching [id]/[launcher] versions, or the
  // package is rejected. app.conf is generated from these fields, so it is NOT
  // authored here.
  const inlineApp = {
    name: 'my_custom_ta',
    label: 'My Custom TA',
    version: '1.0.0',
    source: 'inline',
    visibility: 'app',
    state: 'enabled',
    upgradePolicy: 'manual',
    appFiles: [
      { path: 'default/inputs.conf', content: '[monitor:///var/log/app.log]\nindex = main' },
    ],
  }

  it('validates an inline app built from files', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: inlineApp }]))
    expect(result.valid).toBe(true)
  })

  it('does not require a source reference when authoring inline', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: inlineApp }]))
    expect(result.errors.some((e) => e.field.endsWith('.sourceRef'))).toBe(false)
  })

  it('requires at least one file when authoring inline', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...inlineApp, appFiles: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.appFiles') && e.code === 'required')).toBe(true)
  })

  it('rejects an unsafe file path', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...inlineApp, appFiles: [{ path: '../etc/passwd', content: 'x' }] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects a file outside the standard app folders', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...inlineApp, appFiles: [{ path: 'random/thing.conf', content: 'x' }] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('detects duplicate file paths', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            ...inlineApp,
            appFiles: [
              { path: 'default/app.conf', content: '[launcher]' },
              { path: 'default/app.conf', content: '[ui]' },
            ],
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate' && e.field.includes('appFiles'))).toBe(true)
  })

  it('requires a label and a version, which app.conf cannot be built without', async () => {
    const { label, version, ...noIdentity } = inlineApp
    const result = await validate(makeCtx([{ name: 'sec1', fields: noIdentity }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.label'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.version'))).toBe(true)
  })

  it('warns that an authored app.conf is ignored, because it is generated', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            ...inlineApp,
            appFiles: [
              ...inlineApp.appFiles,
              { path: 'default/app.conf', content: '[launcher]\nversion = 9.9.9' },
            ],
          },
        },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'generated_file_ignored')).toBe(true)
  })

  it('rejects local/ in a package — it shadows default/ and survives upgrades', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            ...inlineApp,
            appFiles: [{ path: 'local/props.conf', content: '[x]\na = b' }],
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'local_in_package')).toBe(true)
  })

  it('warns when an inline app declares only non-conf assets', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...inlineApp, appFiles: [{ path: 'bin/run.py', content: 'print(1)' }] } }]),
    )
    expect(result.warnings.some((w) => w.code === 'no_conf_files')).toBe(true)
  })
  it('ships an unnamed app under the name of the configuration', async () => {
    // Authoring .conf files must not also mean inventing an app id: the
    // configuration IS the app.
    const { name, ...unnamed } = inlineApp
    const ctx = makeCtx([{ name: 'sec1', fields: unnamed }])
    ctx.canvas.name = 'Acme SOC Add-on'

    const result = await validate(ctx)

    expect(result.valid).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.name'))).toBe(false)
  })

  it('rejects only when the configuration name yields no usable app id', async () => {
    const { name, ...unnamed } = inlineApp
    const ctx = makeCtx([{ name: 'sec1', fields: unnamed }])
    ctx.canvas.name = '!!!'

    const result = await validate(ctx)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.name') && e.code === 'required')).toBe(true)
  })
  it('allows indexes.conf in an Enterprise app, warning that it targets indexers', async () => {
    // Shipping indexes.conf in an app pushed to the cluster manager is how indexes
    // are defined across an indexer cluster. Only Splunkbase add-ons may not do it.
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            ...inlineApp,
            appFiles: [
              { path: 'default/indexes.conf', content: '[acme_events]' },
            ],
          },
        },
      ]),
    )

    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'indexes_conf_targets_indexers')).toBe(true)
  })
})
