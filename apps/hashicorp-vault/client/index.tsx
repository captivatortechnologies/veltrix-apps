import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'hashicorp-vault',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/hashicorp-vault/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/hashicorp-vault/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/hashicorp-vault/connections', label: 'Connections', icon: 'link' },
  ],
}
