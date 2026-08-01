import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'opencti',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/opencti/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/opencti/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/opencti/connections', label: 'Connections', icon: 'link' },
  ],
}
