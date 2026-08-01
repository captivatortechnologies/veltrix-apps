import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'tanium',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/tanium/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/tanium/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/tanium/connections', label: 'Connections', icon: 'link' },
  ],
}
