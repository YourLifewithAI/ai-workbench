// The square (D-71): the front door on a desktop. The map itself is the Shell's navigation at this route; the
// screen is the town hall's notice board under it. Below `md` there is no village — the phone lands on the
// Dashboard, which is what the installed app's start_url already says.
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { MD, useMediaQuery } from '../lib/media.js';
import { Prose, ScreenTitle } from '../components/ui/text.js';
import { TownHallBoard } from '../village/TownHallBoard.js';
import { useLiveRuns } from './Runs.js';

export function Village() {
  const wide = useMediaQuery(MD);
  const location = useLocation();
  useLiveRuns(['dashboard']);

  // "Back to the village" hands focus to the title rather than dropping it at the top of the document, so a
  // keyboard user lands where the eye does.
  useEffect(() => {
    if ((location.state as { focus?: string } | null)?.focus === 'title') document.getElementById('screen-title')?.focus();
  }, [location.state]);

  if (!wide) return <Navigate to="/dashboard" replace />;

  return (
    <section aria-labelledby="screen-title">
      <ScreenTitle tabIndex={-1}>Village</ScreenTitle>
      <Prose className="mt-2">Twelve buildings, one for each part of the workbench. Hover one to read what it is for; enter one to work there.</Prose>
      <TownHallBoard className="mt-6" />
    </section>
  );
}
