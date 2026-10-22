import type { CommittedFile, CommittedSource, SourceSide } from '../../domain/committed-source';

export function committedDocumentUri(
  source: CommittedSource,
  file: CommittedFile,
  side: SourceSide,
): string {
  const revision = side === 'old' ? source.mergeBase : source.head;
  const path = file[side]?.path ?? file.path;
  const encodedPath = path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16)}`,
      ),
    )
    .join('/');
  return `crw-source://${source.id}/${side === 'old' ? 'Original' : 'New'}-${revision}/${encodedPath}?file=${file.id}&side=${side}`;
}
