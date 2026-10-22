import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { StoreError, type StoreConfiguration } from './contracts';

// HOME and USERPROFILE can differ between VS Code profiles/copies. The fixed
// rendezvous always uses the account database's OS-user home instead.
export function resolveStoreConfiguration(location: string): StoreConfiguration {
  const osHome = userInfo().homedir;
  let candidateRoot: string;
  switch (process.platform) {
    case 'darwin':
      candidateRoot = join(osHome, 'Library', 'Application Support', 'CodeReviewWorkbench');
      break;
    case 'win32': {
      const local = process.env.LOCALAPPDATA ?? join(osHome, 'AppData', 'Local');
      if (!isAbsolute(local))
        throw new StoreError(
          'UNSUPPORTED_ROOT',
          'LOCALAPPDATA must be an absolute local directory.',
        );
      candidateRoot = join(local, 'CodeReviewWorkbench');
      break;
    }
    default: {
      const data = process.env.XDG_DATA_HOME;
      if (data && !isAbsolute(data))
        throw new StoreError(
          'UNSUPPORTED_ROOT',
          'XDG_DATA_HOME must be an absolute local directory.',
        );
      candidateRoot = join(
        data && isAbsolute(data) ? data : join(osHome, '.local', 'share'),
        'code-review-workbench',
      );
    }
  }
  return { osHome, candidateRoot, windowId: randomUUID(), location: realpathSync.native(location) };
}
