import { Card } from './ui/card.js';

export function Placeholder({ title, shipsIn, summary }: { title: string; shipsIn: string; summary: string }) {
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title" className="text-2xl font-semibold">{title}</h1>
      <Card className="mt-4">
        <p className="text-gray-700 dark:text-gray-300">{summary}</p>
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">Arrives in {shipsIn}. Until then this route exists so navigation is complete and every screen is reachable by keyboard.</p>
      </Card>
    </section>
  );
}
