// ============================================================================
// CLI configuration (~/.veltrix/config.json)
//
// Stores the platform URL and API key per profile. The file is chmod 600 on
// POSIX systems; on Windows it relies on the user-profile ACL.
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_DIR = path.join(os.homedir(), '.veltrix')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return { profiles: {} }
  }
}

export function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(CONFIG_FILE, 0o600)
  } catch {
    // Windows: chmod is a no-op; the file lives under the user profile.
  }
}

/**
 * Resolve the active profile. Precedence:
 *   VELTRIX_API_KEY / VELTRIX_URL env vars > saved profile.
 */
export function getProfile(name = 'default') {
  const envKey = process.env.VELTRIX_API_KEY
  const envUrl = process.env.VELTRIX_URL
  const saved = loadConfig().profiles?.[name]

  const url = envUrl || saved?.url
  const apiKey = envKey || saved?.apiKey
  if (!url || !apiKey) return null
  return { url, apiKey }
}

export function setProfile(name, profile) {
  const config = loadConfig()
  config.profiles = config.profiles || {}
  config.profiles[name] = profile
  saveConfig(config)
}

export function deleteProfile(name = 'default') {
  const config = loadConfig()
  if (config.profiles?.[name]) {
    delete config.profiles[name]
    saveConfig(config)
    return true
  }
  return false
}

export function configPath() {
  return CONFIG_FILE
}
