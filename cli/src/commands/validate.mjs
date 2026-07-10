import path from 'node:path'
import { validateApp, checkClientBundle, printResults } from '../lib/validator.mjs'

export async function validateCommand(dir) {
  const result = validateApp(dir)
  const bundle = await checkClientBundle(dir, result.manifest)
  result.errors.push(...bundle.errors)
  result.warnings.push(...bundle.warnings)
  const failed = printResults(path.basename(path.resolve(dir)), result)
  if (failed) process.exit(1)
}
