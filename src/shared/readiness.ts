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
  // A recreated screen gets a new instance; each check gets a new request.
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

export function isReadinessRequest(value: unknown): value is ReadinessRequest {
  if (!isRecord(value)) {
    return false;
  }

  const hasExpectedFields = Object.keys(value).length === 5 && value.version === 1;
  const hasSupportedAction = value.type === 'ready' || value.type === 'recheck';
  const hasValidIdentity =
    isMessageIdentifier(value.instanceId) && isMessageIdentifier(value.requestId);
  const hasRendererDescription =
    typeof value.renderer === 'string' && value.renderer.length > 0 && value.renderer.length <= 512;

  return hasExpectedFields && hasSupportedAction && hasValidIdentity && hasRendererDescription;
}

export function isReadinessResponse(value: unknown): value is ReadinessResponse {
  if (!isRecord(value)) {
    return false;
  }

  const hasSupportedMessage = value.version === 1 && value.type === 'readinessResult';
  const hasValidIdentity =
    isMessageIdentifier(value.instanceId) && isMessageIdentifier(value.requestId);

  return hasSupportedMessage && hasValidIdentity && isReadinessReport(value.report);
}

function isReadinessReport(value: unknown): value is ReadinessReport {
  if (!isRecord(value)) {
    return false;
  }

  const hasValidTimestamp = typeof value.checkedAt === 'string' && value.checkedAt.length < 64;
  const hasValidChecks =
    Array.isArray(value.checks) && value.checks.length <= 20 && value.checks.every(isCapability);

  return value.reviewAvailable === false && hasValidTimestamp && hasValidChecks;
}

function isCapability(value: unknown): value is Capability {
  if (!isRecord(value)) {
    return false;
  }

  const hasValidId = isMessageIdentifier(value.id);
  const hasValidLabel = typeof value.label === 'string' && value.label.length <= 128;
  const hasValidDetail = typeof value.detail === 'string' && value.detail.length <= 4096;
  const hasValidStatus =
    value.status === 'passed' || value.status === 'blocked' || value.status === 'pending';

  return hasValidId && hasValidLabel && hasValidDetail && hasValidStatus;
}

function isMessageIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
