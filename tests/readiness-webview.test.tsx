// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReadinessRequest } from '../src/shared/readiness';

test('the real webview entry rejects malformed and stale host responses and requests a fresh check', async () => {
  const requests: ReadinessRequest[] = [];
  document.body.innerHTML = '<div id="root" data-instance="fixture-instance"></div>';
  Object.assign(globalThis, { acquireVsCodeApi: () => ({ postMessage: (request: ReadinessRequest) => requests.push(request) }) });
  await act(async () => { await import('../src/webviews/main'); });
  await waitFor(() => expect(requests.length).toBe(1));
  const respond = async (request: ReadinessRequest, detail: string, extra = {}) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      version: 1, type: 'readinessResult', instanceId: request.instanceId, requestId: request.requestId,
      report: { checkedAt: '2026-10-16T00:00:00Z', reviewAvailable: false,
        checks: [{ id: 'git', label: 'Git', status: 'blocked', detail }] }, ...extra,
    } }));
  });
  await respond(requests[0]!, 'malformed', { report: { reviewAvailable: true } });
  await respond({ ...requests[0]!, instanceId: 'old-view' }, 'stale');
  expect(screen.queryByText('malformed')).toBeNull();
  expect(screen.queryByText('stale')).toBeNull();
  await respond(requests[0]!, '<script>untrusted repository text</script>');
  expect(await screen.findByText('<script>untrusted repository text</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(requests.length).toBe(2));
  expect(requests[1]!.type).toBe('recheck');
  await respond(requests[0]!, 'old result');
  expect(screen.queryByText('old result')).toBeNull();
  await respond(requests[1]!, 'Open an already-cloned repository.');
  expect(await screen.findByText('Open an already-cloned repository.')).toBeTruthy();
});
