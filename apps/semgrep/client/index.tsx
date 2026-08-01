import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'semgrep',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/semgrep/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/semgrep/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/semgrep/connections', label: 'Connections', icon: 'link' },
  ],
}
