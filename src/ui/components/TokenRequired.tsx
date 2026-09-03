import { useState } from 'react';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';
import { setToken } from '../lib/auth.js';

export function TokenRequired() {
  const [value, setValue] = useState('');
  return (
    <main id="main" className="mx-auto flex min-h-full max-w-lg flex-col justify-center p-6">
      <Card>
        <h1 className="text-xl font-semibold">Runtime token required</h1>
        <p className="mt-2 text-gray-700 dark:text-gray-300">
          This page talks to your workbench runtime, and the runtime only answers callers that present its token. The token travels in the URL that <code className="font-mono text-sm">workbench start</code> prints, and this tab no longer has it (a refresh drops it on purpose).
        </p>
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-gray-700 dark:text-gray-300">
          <li>Go back to the terminal running <code className="font-mono text-sm">workbench start</code>.</li>
          <li>Open the printed URL again (it ends in <code className="font-mono text-sm">#token=…</code>).</li>
        </ol>
        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) setToken(value);
          }}
        >
          <label htmlFor="token" className="block text-sm font-medium">Or paste the token</label>
          <input id="token" name="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950" />
          <Button className="mt-3" type="submit" disabled={!value.trim()}>Use this token</Button>
        </form>
      </Card>
    </main>
  );
}
