import path from 'node:path'
import { validateApp, printResults } from '../lib/validator.mjs'

export async function validateCommand(dir) {
  const result = validateApp(dir)
  const failed = printResults(path.basename(path.resolve(dir)), result)
  if (failed) process.exit(1)
}
