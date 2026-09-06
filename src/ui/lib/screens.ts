// The twelve screens, in navigation order (ui.md §Navigation). This is the one list: the sidebar, the phone's
// "More", the village (RUN-19) and the router all read it, and the shell e2e asserts these labels reach a heading.
// `summary` is one sentence — it is what the village shows when a building is hovered or focused.
export interface Screen { path: string; label: string; shipsIn: string; summary: string }

export const SCREENS: Screen[] = [
  { path: '/welcome', label: 'Welcome', shipsIn: 'RUN-00', summary: 'The first-run path.' },
  { path: '/dashboard', label: 'Dashboard', shipsIn: 'RUN-05', summary: 'What needs you, what is running, and what today cost.' },
  { path: '/library', label: 'Library', shipsIn: 'RUN-03', summary: 'Projects, documents, and every version your agents produce.' },
  { path: '/workflows', label: 'Workflows', shipsIn: 'RUN-04', summary: 'Multi-step workflows with a live graph and a run form built from their inputs.' },
  { path: '/agents', label: 'Agents', shipsIn: 'RUN-01', summary: 'Agent definitions, versions, model policies, and their run form.' },
  { path: '/runs', label: 'Runs', shipsIn: 'RUN-00', summary: 'Every run with what it cost and produced.' },
  { path: '/review', label: 'Review', shipsIn: 'RUN-05', summary: 'Outputs waiting for a rating and approvals waiting for a decision.' },
  { path: '/models', label: 'Models', shipsIn: 'RUN-02', summary: 'The model catalog with pricing, capabilities, and data policy.' },
  { path: '/memory', label: 'Memory', shipsIn: 'RUN-08', summary: 'What agents remember, with provenance and trust.' },
  { path: '/tools', label: 'Tools', shipsIn: 'RUN-06', summary: 'Built-in tools, MCP servers, the grant matrix, and denial history.' },
  { path: '/evaluate', label: 'Evaluate', shipsIn: 'RUN-10', summary: 'Compare models side by side; datasets and experiments.' },
  { path: '/settings', label: 'Settings', shipsIn: 'RUN-00', summary: 'Workspace, providers, the network, and budgets.' },
];
