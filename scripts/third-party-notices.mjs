import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

// Use esbuild's actual input graph, including transitives, rather than assuming
// --no-dependencies will copy bundled packages' license files for us.
export async function writeThirdPartyNotices(results) {
  const packages = new Map();
  for (const input of results.flatMap((result) => Object.keys(result.metafile.inputs))) {
    if (!input.includes('node_modules/')) continue;
    for (
      let directory = dirname(resolve(input));
      directory.includes('node_modules');
      directory = dirname(directory)
    ) {
      let metadata;
      try {
        metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (!metadata.name || !metadata.version) continue;
      const key = `${metadata.name}@${metadata.version}`;
      if (!packages.has(key)) {
        const licenses = (await readdir(directory)).filter((name) =>
          /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name),
        );
        if (!licenses.length)
          throw new Error(`Bundled runtime dependency ${key} has no license notice.`);
        packages.set(
          key,
          (
            await Promise.all(
              licenses.sort().map((name) => readFile(join(directory, name), 'utf8')),
            )
          ).join('\n'),
        );
      }
      break;
    }
  }
  const text = [...packages]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, license]) => `${name}\n${'='.repeat(name.length)}\n\n${license}`)
    .join('\n\n');
  await writeFile('dist/third-party-notices.txt', text);
}
