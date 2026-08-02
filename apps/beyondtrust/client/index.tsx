import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'beyondtrust',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/beyondtrust/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/beyondtrust/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/beyondtrust/connections', label: 'Connections', icon: 'link' },
  ],
}
