import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAuthState, onAuthChange } from './lib/auth.js';
import { welcomeDone } from './lib/welcome.js';
import { Shell, SCREENS } from './components/Shell.js';
import { Placeholder } from './components/Placeholder.js';
import { TokenRequired } from './components/TokenRequired.js';
import { Welcome } from './screens/Welcome.js';
import { Runs } from './screens/Runs.js';
import { Agents, AgentDetail } from './screens/Agents.js';
import { Models } from './screens/Models.js';
import { Library, ProjectDetail, DocumentView } from './screens/Library.js';
import { Workflows, WorkflowDetail } from './screens/Workflows.js';
import { RunDetail } from './screens/RunDetail.js';
import { Settings } from './screens/Settings.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

export function App() {
  const [auth, setAuth] = useState(getAuthState());
  useEffect(() => onAuthChange(setAuth), []);

  if (auth === 'required') return <TokenRequired />;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to={welcomeDone() ? '/runs' : '/welcome'} replace />} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/library" element={<Library />} />
            <Route path="/library/:slug" element={<ProjectDetail />} />
            <Route path="/library/:slug/:id" element={<DocumentView />} />
            <Route path="/models" element={<Models />} />
            <Route path="/workflows" element={<Workflows />} />
            <Route path="/workflows/:id" element={<WorkflowDetail />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/settings" element={<Settings />} />
            {SCREENS.filter((s) => !['/welcome', '/runs', '/settings', '/agents', '/models', '/library', '/workflows'].includes(s.path)).map((s) => (
              <Route key={s.path} path={s.path} element={<Placeholder title={s.label} shipsIn={s.shipsIn} summary={s.summary} />} />
            ))}
            <Route path="*" element={<Placeholder title="Not found" shipsIn="no run" summary="There is no screen at this address." />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
