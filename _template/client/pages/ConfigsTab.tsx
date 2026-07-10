// =============================================================================
// A page rendered as a TAB inside the Overview page (see manifest.yaml:
// nav: tab, parent: "/"). It is only shown to users holding the app permission
// declared in `requiresPermission` — the platform enforces that for you.
//
// You render only the body. Compose it from @veltrixsecops/ui primitives so it
// matches the portal and follows the tenant's theme.
// =============================================================================

import React from 'react'

export default function ConfigsTab() {
  return (
    <div>
      <h2>Configurations</h2>
      <p>
        List this tool&apos;s configurations here. Authoring and approval happen in the
        platform&apos;s Configuration Canvas — link to it rather than rebuilding it.
      </p>
    </div>
  )
}
