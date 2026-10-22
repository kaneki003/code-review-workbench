import { writeFile } from 'node:fs/promises';

import * as vscode from 'vscode';
import { suite, suiteSetup, suiteTeardown, teardown } from 'mocha';

import type { HostTestEvidence } from './support';
import { registerReadinessTest, registerReadinessReentryTest } from './readiness.test';
import { registerStorageTest, registerStorageRecoveryTest } from './storage.test';
import { registerOverviewTest } from './overview.test';
import { registerReviewFlowTest } from './review-flow.test';
suite('Installed workbench VSIX', () => {
  const evidence: HostTestEvidence = { status: 'running', tests: [] };
  const saveEvidence = () =>
    writeFile(process.env.CRW_HOST_EVIDENCE!, JSON.stringify(evidence, null, 2));
  suiteSetup(async () => {
    evidence.host = {
      os: process.platform,
      architecture: process.arch,
      osRelease: (await import('node:os')).release(),
      vscode: vscode.version,
      runtime: process.versions,
    };
    await saveEvidence();
  });
  teardown(async function () {
    const current = this.currentTest!;
    evidence.tests.push({
      name: current.title,
      result: current.state ?? 'unknown',
      ...(current.err ? { failure: current.err.message } : {}),
    });
    await saveEvidence();
  });
  suiteTeardown(async () => {
    evidence.status = evidence.tests.some((result) => result.result !== 'passed')
      ? 'failed'
      : 'passed';
    await saveEvidence();
  });
  registerReadinessTest(evidence, saveEvidence);
  registerStorageTest(evidence, saveEvidence);
  registerOverviewTest(evidence, saveEvidence);
  registerReviewFlowTest(evidence, saveEvidence);
  registerStorageRecoveryTest(evidence, saveEvidence);
  registerReadinessReentryTest(evidence, saveEvidence);
});
