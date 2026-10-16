import { useEffect, useRef, useState } from 'react';
import type { ReadinessReport } from '../shared/readiness';

export function ReadinessView({ check }: { check: () => Promise<ReadinessReport> }) {
  const [report, setReport] = useState<ReadinessReport>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const next = await check();
      if (active.current) setReport(next);
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : 'Check failed. Try again.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void run();
    return () => {
      active.current = false;
    };
  }, [check]);
  return (
    <main className="mx-auto max-w-3xl p-4 text-foreground">
      <h1 className="text-xl font-semibold">Workbench readiness</h1>
      <p>
        Inspect this installation before starting a review. This check leaves repository and private
        review data untouched.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="my-4 rounded bg-action px-3 py-2 text-action-text disabled:opacity-60"
      >
        {busy ? 'Checking…' : 'Check again'}
      </button>
      <div role="status" aria-live="polite" aria-busy={busy}>
        {error && <p>{error}</p>}
        {busy && <p>Checking local capabilities…</p>}
        {report && (
          <>
            <p>Review unavailable · readiness inspection only</p>
            <ul className="list-none space-y-3 p-0">
              {report.checks.map((item) => (
                <li key={item.id} className="rounded border border-outline p-3">
                  <h2 className="m-0 font-semibold">
                    {item.label} ·{' '}
                    {item.status === 'passed'
                      ? 'Passed'
                      : item.status === 'blocked'
                        ? 'Blocked'
                        : 'Pending'}
                  </h2>
                  <p className="mb-0 whitespace-pre-wrap break-words">{item.detail}</p>
                </li>
              ))}
            </ul>
            <p className="text-muted">Checked {report.checkedAt}</p>
          </>
        )}
      </div>
    </main>
  );
}
