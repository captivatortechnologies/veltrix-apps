// =============================================================================
// A page rendered as a TAB inside the Overview page (see manifest.yaml:
// nav: tab, parent: "/"). It is only shown to users holding the app permission
// declared in `requiresPermission` — the platform enforces that for you.
//
// You render only the body. Compose it from the platform design-system kit at
// '@veltrixsecops/app-sdk/ui' so it matches the portal, follows the tenant's
// theme (light/dark), and picks up your app's branding automatically.
// =============================================================================

import React from 'react'
import { Button, Card, CardHeader, CardBody } from '@veltrixsecops/app-sdk/ui'

export default function ConfigsTab() {
  return (
    <Card>
      <CardHeader actions={<Button variant="primary" size="sm">New configuration</Button>}>
        Configurations
      </CardHeader>
      <CardBody>
        List this tool&apos;s configurations here. Authoring and approval happen in the
        platform&apos;s Configuration Canvas — link to it rather than rebuilding it.
      </CardBody>
    </Card>
  )
}
