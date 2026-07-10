import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

const APP_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
const TEMPLATE_TARBALL =
  'https://codeload.github.com/captivatortechnologies/veltrix-apps/tar.gz/refs/heads/main'
const TEMPLATE_PREFIX = 'veltrix-apps-main/_template/'

/**
 * Scaffold a new app with the canonical Veltrix layout by pulling the
 * latest _template from the community repo and rewriting its identity.
 */
export async function initCommand(appId, options) {
  if (!APP_ID_RE.test(appId)) {
    console.error(`✖ App id must match ${APP_ID_RE} (lowercase, hyphens), got "${appId}"`)
    process.exit(1)
  }

  const targetDir = path.resolve(options.dir ?? '.', appId)
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    console.error(`✖ ${targetDir} already exists and is not empty`)
    process.exit(1)
  }

  console.log(`Fetching the latest app template…`)
  let response
  try {
    response = await fetch(TEMPLATE_TARBALL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (e) {
    console.error(`✖ Could not download the template: ${e.message}`)
    console.error('  Check your network, or copy _template/ manually from')
    console.error('  https://github.com/captivatortechnologies/veltrix-apps')
    process.exit(1)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-init-'))
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    await pipeline(
      response.body,
      tar.extract({
        cwd: targetDir,
        strip: 2, // veltrix-apps-main/_template/
        filter: (entryPath) => entryPath.startsWith(TEMPLATE_PREFIX),
      }),
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const extracted = fs.readdirSync(targetDir)
  if (!extracted.includes('manifest.yaml')) {
    console.error('✖ Template extraction failed (no manifest.yaml) — repo layout may have changed')
    process.exit(1)
  }

  // Rewrite the template identity ("my-app" / "app_myapp_") to the new app id.
  const displayName = appId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  const tableToken = appId.replace(/-/g, '')

  const rewrite = (relPath, replacer) => {
    const filePath = path.join(targetDir, relPath)
    if (!fs.existsSync(filePath)) return
    fs.writeFileSync(filePath, replacer(fs.readFileSync(filePath, 'utf8')))
  }

  rewrite('manifest.yaml', (source) =>
    source
      .replaceAll('my-app', appId)
      .replaceAll('app_myapp_', `app_${tableToken}_`)
      .replace(/^name: .*$/m, `name: "${displayName}"`)
      .replace(/^vendor: .*$/m, 'vendor: "Your Company"'),
  )
  rewrite('package.json', (source) => source.replaceAll('veltrix-app-template', `veltrix-app-${appId}`))
  rewrite('client/index.tsx', (source) => source.replaceAll('my-app', appId))
  rewrite('README.md', (source) => source.replace('# Veltrix App Template', `# ${displayName}`))

  console.log(`✔ Scaffolded ${appId} with the canonical app layout`)
  console.log(`  ${targetDir}`)
  console.log('')
  console.log('Next steps:')
  console.log(`  cd ${path.relative(process.cwd(), targetDir) || '.'}`)
  console.log('  npm install')
  console.log('  # edit manifest.yaml, implement handlers/<configType>/*')
  console.log('  npm run typecheck && npx veltrix validate .')
}
