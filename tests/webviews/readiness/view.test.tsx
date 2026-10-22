// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReadinessView } from '../../../src/webviews/readiness/readiness-view';

afterEach(cleanup);
test('the retry control has an accessible name and failures remain retryable with textual status', async () => {
  const check = async () => {
    throw new Error('Host did not respond. Check again.');
  };
  render(<ReadinessView check={check} />);
  expect(await screen.findByText('Host did not respond. Check again.')).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'Check again' });
  retry.focus();
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(await screen.findByText('Host did not respond. Check again.')).toBeTruthy();
});
