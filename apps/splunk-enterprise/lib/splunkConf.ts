// ========================================================================
// Shared Splunk .conf helpers — parse authored .conf text into stanzas and
// apply them over the REST configs API. Used by both the Splunk Apps config
// type (writes into the app's own namespace) and the Config Files config type
// (writes into a chosen target-app namespace).
// ========================================================================

import { getEntityContent, postForm } from './splunkApi'

/** One parsed stanza from a .conf file: a name plus its key/value settings. */
export interface ConfStanza {
  name: string
  settings: Record<string, string>
}

/** A single authored file (`<folder>/<name>` path + text content). */
export interface ConfFile {
  path?: string
  content?: string
}

/**
 * Parse Splunk .conf text into ordered stanzas. Lines before the first
 * `[stanza]` header belong to the implicit `default` stanza. Blank lines and
 * `#`/`;` comments are ignored; `key = value` pairs are collected per stanza.
 */
export function parseConf(text: string): ConfStanza[] {
  const stanzas: ConfStanza[] = []
  let current: ConfStanza = { name: 'default', settings: {} }
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      if (Object.keys(current.settings).length > 0) stanzas.push(current)
      current = { name: header[1].trim(), settings: {} }
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key) current.settings[key] = value
  }
  if (Object.keys(current.settings).length > 0) stanzas.push(current)
  return stanzas
}

/** Create the stanza if absent, otherwise update its settings in place. */
export async function upsertStanza(
  baseUrl: string,
  auth: Record<string, string>,
  nsBase: string,
  stanza: ConfStanza,
): Promise<void> {
  const existing = await getEntityContent(baseUrl, auth, `${nsBase}/${encodeURIComponent(stanza.name)}`)
  if (existing) {
    await postForm(baseUrl, auth, `${nsBase}/${encodeURIComponent(stanza.name)}`, stanza.settings)
  } else {
    await postForm(baseUrl, auth, nsBase, { name: stanza.name, ...stanza.settings })
  }
}

/**
 * Apply authored files as REST config stanzas under `namespaceApp`'s namespace.
 * `default`/`local` `*.conf` files are upserted stanza-by-stanza; every other
 * file is returned in `packagedOnly` (binary/script assets can't be written
 * over REST). Returns the list of applied file paths.
 */
export async function applyConfFiles(
  baseUrl: string,
  auth: Record<string, string>,
  namespaceApp: string,
  files: ConfFile[],
): Promise<{ applied: string[]; packagedOnly: string[] }> {
  const applied: string[] = []
  const packagedOnly: string[] = []

  for (const file of files) {
    const path = typeof file?.path === 'string' ? file.path.trim() : ''
    if (!path) continue
    // A path may be a bare filename ("inputs.conf") or "<folder>/<name>".
    const slash = path.indexOf('/')
    const folder = slash === -1 ? 'default' : path.slice(0, slash)
    const filename = slash === -1 ? path : path.slice(slash + 1)

    if ((folder === 'default' || folder === 'local') && filename.endsWith('.conf')) {
      const confName = filename.slice(0, -'.conf'.length)
      const nsBase = `/servicesNS/nobody/${encodeURIComponent(namespaceApp)}/configs/conf-${encodeURIComponent(confName)}`
      for (const stanza of parseConf(file.content ?? '')) {
        await upsertStanza(baseUrl, auth, nsBase, stanza)
      }
      applied.push(path)
    } else {
      packagedOnly.push(path)
    }
  }

  return { applied, packagedOnly }
}
