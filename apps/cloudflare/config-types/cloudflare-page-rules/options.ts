// Options provider for Page Rules. Zone-scoped, so it powers the canvas-level
// "Domain" picker (source = "zones") via the shared Cloudflare provider — a thin
// re-export keeping the per-config-type handler path the platform expects.
export { default } from '../lib/cloudflareOptions'
