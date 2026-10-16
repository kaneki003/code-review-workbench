export interface Capability {
  id: string;
  label: string;
  status: 'passed' | 'blocked' | 'pending';
  detail: string;
}

export interface ReadinessReport {
  checkedAt: string;
  checks: Capability[];
  reviewAvailable: false;
}

export interface ReadinessRequest {
  version: 1;
  type: 'ready' | 'recheck';
  instanceId: string;
  requestId: string;
  renderer: string;
}
export interface ReadinessResponse {
  version: 1;
  type: 'readinessResult';
  instanceId: string;
  requestId: string;
  report: ReadinessReport;
}

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function isReadinessRequest(value: unknown): value is ReadinessRequest {
  return record(value) && Object.keys(value).length === 5 && value.version === 1
    && (value.type === 'ready' || value.type === 'recheck') && identifier(value.instanceId) && identifier(value.requestId)
    && typeof value.renderer === 'string' && value.renderer.length > 0 && value.renderer.length <= 512;
}
export function isReadinessResponse(value: unknown): value is ReadinessResponse {
  if (!record(value) || value.version !== 1 || value.type !== 'readinessResult'
    || !identifier(value.instanceId) || !identifier(value.requestId) || !record(value.report)) return false;
  const report = value.report;
  return report.reviewAvailable === false && typeof report.checkedAt === 'string' && report.checkedAt.length < 64
    && Array.isArray(report.checks) && report.checks.length <= 20 && report.checks.every(check => record(check)
      && identifier(check.id) && typeof check.label === 'string' && check.label.length <= 128
      && ['passed', 'blocked', 'pending'].includes(String(check.status))
      && typeof check.detail === 'string' && check.detail.length <= 4096);
}
