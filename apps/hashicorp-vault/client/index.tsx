import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'hashicorp-vault',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/hashicorp-vault/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/hashicorp-vault/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
