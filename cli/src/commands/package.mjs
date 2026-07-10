import path from 'node:path'
import { validateApp, printResults } from '../lib/validator.mjs'
import { packageApp } from '../lib/packager.mjs'

export async function packageCommand(dir, options) {
  const result = validateApp(dir)
  const failed = printResults(path.basename(path.resolve(dir)), result)
  if (failed) {
    console.error('✖ Fix validation errors before packaging')
    process.exit(1)
  }

  const info = await packageApp(path.resolve(dir), path.resolve(options.out), result.manifest)
  console.log(`✔ Packaged ${info.appId} v${info.version}`)
  console.log(`  file:   ${info.zipPath}`)
  console.log(`  size:   ${(info.sizeBytes / 1024).toFixed(1)} KB (${info.fileCount} files)`)
  console.log(`  sha256: ${info.sha256}`)
}
