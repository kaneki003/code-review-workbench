import { useEffect, useRef, useState } from 'react';
import type { Capability, ReadinessReport } from '../shared/readiness';

interface ReadinessViewProps {
  check: () => Promise<ReadinessReport>;
}

const statusLabels: Record<Capability['status'], string> = {
  passed: 'Passed',
  blocked: 'Blocked',
  pending: 'Pending',
};

export function ReadinessView({ check }: ReadinessViewProps) {
  const [report, setReport] = useState<ReadinessReport>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isChecking, setIsChecking] = useState(false);
  const isMounted = useRef(true);

  async function runCheck() {
    setIsChecking(true);
    setErrorMessage(undefined);

    try {
      const nextReport = await check();
      if (isMounted.current) {
        setReport(nextReport);
      }
    } catch (error) {
      if (isMounted.current) {
        const message = error instanceof Error ? error.message : 'Check failed. Try again.';
        setErrorMessage(message);
      }
    } finally {
      if (isMounted.current) {
        setIsChecking(false);
      }
    }
  }

  useEffect(() => {
    isMounted.current = true;
    void runCheck();

    return () => {
      // A host response can arrive after the user has closed this screen.
      isMounted.current = false;
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
        disabled={isChecking}
        onClick={() => void runCheck()}
        className="my-4 rounded bg-action px-3 py-2 text-action-text disabled:opacity-60"
      >
        {isChecking ? 'Checking…' : 'Check again'}
      </button>
      <div role="status" aria-live="polite" aria-busy={isChecking}>
        {errorMessage && <p>{errorMessage}</p>}
        {isChecking && <p>Checking local capabilities…</p>}
        {report && (
          <>
            <p>Review unavailable · readiness inspection only</p>
            <ul className="list-none space-y-3 p-0">
              {report.checks.map((capability) => (
                <li key={capability.id} className="rounded border border-outline p-3">
                  <h2 className="m-0 font-semibold">
                    {capability.label} · {statusLabels[capability.status]}
                  </h2>
                  <p className="mb-0 whitespace-pre-wrap break-words">{capability.detail}</p>
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
