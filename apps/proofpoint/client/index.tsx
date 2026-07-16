import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'proofpoint',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/proofpoint/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/proofpoint/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/proofpoint/connections', label: 'Connections', icon: 'link' },
  ],
}
