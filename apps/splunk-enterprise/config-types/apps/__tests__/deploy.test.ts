import { parseConf } from '../deploy'

describe('Splunk Apps deploy — parseConf', () => {
  it('parses stanzas with settings', () => {
    const stanzas = parseConf('[launcher]\nversion = 1.0.0\nauthor = Veltrix\n\n[ui]\nis_visible = true')
    expect(stanzas).toEqual([
      { name: 'launcher', settings: { version: '1.0.0', author: 'Veltrix' } },
      { name: 'ui', settings: { is_visible: 'true' } },
    ])
  })

  it('ignores comments and blank lines', () => {
    const stanzas = parseConf('# a comment\n; another\n\n[install]\nstate = enabled\n')
    expect(stanzas).toEqual([{ name: 'install', settings: { state: 'enabled' } }])
  })

  it('collects pre-header settings under the implicit default stanza', () => {
    const stanzas = parseConf('index = main\n[monitor:///var/log/x.log]\nsourcetype = syslog')
    expect(stanzas[0]).toEqual({ name: 'default', settings: { index: 'main' } })
    expect(stanzas[1]).toEqual({ name: 'monitor:///var/log/x.log', settings: { sourcetype: 'syslog' } })
  })

  it('keeps = signs inside values', () => {
    const stanzas = parseConf('[props]\nEXTRACT-kv = (?<k>\\w+)=(?<v>\\w+)')
    expect(stanzas[0].settings['EXTRACT-kv']).toBe('(?<k>\\w+)=(?<v>\\w+)')
  })

  it('drops empty stanzas (header with no settings)', () => {
    const stanzas = parseConf('[empty]\n\n[real]\nk = v')
    expect(stanzas).toEqual([{ name: 'real', settings: { k: 'v' } }])
  })

  it('returns nothing for empty input', () => {
    expect(parseConf('')).toEqual([])
  })
})
