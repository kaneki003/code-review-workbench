import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import MarkdownIt from 'markdown-it';
import type { DraftWriterClient } from './draft-client';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]!.content);

export function DraftWriterView({ client }: { client: DraftWriterClient }) {
  const view = useSyncExternalStore(client.subscribe, client.read, client.read);
  const [preview, setPreview] = useState(false);
  const [copyHint, setCopyHint] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const state = view.snapshot?.state;
  const writerId = state?.writerId;
  useEffect(() => {
    client.connect();
  }, [client]);
  useEffect(() => {
    setPreview(false);
    input.current?.focus();
  }, [writerId]);
  const failed = Boolean(view.problem || state?.status === 'failed');
  const busy = Boolean(view.action || state?.status === 'discarding');
  const status = failed
    ? 'Failed to save'
    : state?.status === 'discarding'
      ? 'Discarding local draft…'
      : state && state.committedRevision === view.editRevision
        ? 'Saved on this device'
        : 'Saving on this device…';
  async function copy() {
    input.current?.focus();
    input.current?.select();
    try {
      if (!navigator.clipboard) throw new Error('Select text');
      await navigator.clipboard.writeText(view.body);
      setCopyHint('Input copied.');
    } catch {
      setCopyHint('Input selected. Use your normal Copy shortcut.');
    }
  }
  function format(before: string, after = before) {
    const field = input.current;
    if (!field) return;
    const start = field.selectionStart,
      end = field.selectionEnd;
    client.edit(
      view.body.slice(0, start) +
        before +
        view.body.slice(start, end) +
        after +
        view.body.slice(end),
    );
    field.focus();
    requestAnimationFrame(() =>
      field.setSelectionRange(start + before.length, end + before.length),
    );
  }
  return (
    <main
      className="draft-writer"
      aria-label="Private local draft writer"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state && !busy) {
          event.preventDefault();
          event.stopPropagation();
          client.control('close');
        }
      }}
    >
      {view.recovery && (
        <section className="draft-recovery" aria-label="Unacknowledged input recovery">
          <p>
            Input from {view.recovery.label} was not confirmed before the view changed. Copy it
            before closing this recovery copy.
          </p>
          <textarea
            aria-label="Recovery copy of private feedback"
            value={view.recovery.body}
            readOnly
          />
          <button onClick={() => client.dismissRecovery()}>Close recovery copy</button>
        </section>
      )}
      {!state ? (
        <p role="status">
          {view.snapshot?.fenced
            ? 'Verify the original GitHub account to reopen private feedback.'
            : 'Select a committed source range and choose Write Private Local Draft, or open a saved local draft.'}
        </p>
      ) : (
        <>
          <header className="draft-target">
            <div>
              <span className="draft-tag">Local draft</span>
              <span>PR #{state.review.pullNumber}</span>
              <strong>{state.target.anchor.path}</strong>
            </div>
            <div className="draft-location">
              <span>
                {state.target.anchor.side === 'old' ? 'Original' : 'New'} · L
                {state.target.anchor.range.startLine + 1}:
                {state.target.anchor.range.startCharacter + 1}–L
                {state.target.anchor.range.endLine + 1}:{state.target.anchor.range.endCharacter + 1}
              </span>
              <code title={state.target.anchor.commit}>{state.target.anchor.commit}</code>
            </div>
          </header>
          <section className="draft-composer" aria-label="Feedback composition">
            <div
              className="draft-tabs"
              role="tablist"
              aria-label="Feedback mode"
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setPreview(!preview);
                  (
                    event.currentTarget.querySelector(
                      preview ? '#draft-write-tab' : '#draft-preview-tab',
                    ) as HTMLElement
                  )?.focus();
                }
              }}
            >
              <button
                id="draft-write-tab"
                role="tab"
                aria-selected={!preview}
                aria-controls="draft-body"
                tabIndex={preview ? -1 : 0}
                onClick={() => setPreview(false)}
              >
                Write
              </button>
              <button
                id="draft-preview-tab"
                role="tab"
                aria-selected={preview}
                aria-controls="draft-body"
                tabIndex={preview ? 0 : -1}
                onClick={() => setPreview(true)}
              >
                Preview
              </button>
              <span className="draft-formatting" aria-label="Markdown formatting">
                <button
                  aria-label="Bold"
                  title="Bold"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('**')}
                >
                  <b>B</b>
                </button>
                <button
                  aria-label="Italic"
                  title="Italic"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('_')}
                >
                  <i>I</i>
                </button>
                <button
                  aria-label="Code"
                  title="Code"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('`')}
                >
                  〈〉
                </button>
              </span>
            </div>
            <div
              id="draft-body"
              role="tabpanel"
              aria-labelledby={preview ? 'draft-preview-tab' : 'draft-write-tab'}
            >
              {preview ? (
                <div
                  className="draft-preview"
                  dangerouslySetInnerHTML={{
                    __html: markdown.render(view.body || '*Nothing to preview.*'),
                  }}
                />
              ) : (
                <textarea
                  ref={input}
                  aria-label="Private feedback"
                  aria-describedby="draft-private-note draft-save-state"
                  spellCheck
                  value={view.body}
                  readOnly={busy || Boolean(view.recovery)}
                  placeholder="Write private feedback…"
                  onChange={(event) => client.edit(event.currentTarget.value)}
                />
              )}
            </div>
            <div className="draft-editor-note">Markdown supported</div>
          </section>
          <footer className="draft-footer">
            <div>
              <div id="draft-save-state" role="status" aria-live="polite">
                {status}
              </div>
              <div id="draft-private-note">Private on this device · Not sent to GitHub</div>
            </div>
            <div className="draft-actions">
              {failed && (
                <>
                  <button onClick={() => void copy()}>Copy input</button>
                  <button
                    className="draft-primary"
                    disabled={busy}
                    onClick={() => client.control('retry')}
                  >
                    Retry
                  </button>
                </>
              )}
              <button disabled={busy} onClick={() => client.control('close')}>
                {view.action === 'close' ? 'Saving before Close…' : 'Close'}
              </button>
              <button
                className="draft-discard"
                disabled={busy}
                onClick={() => client.control('discard')}
              >
                Discard draft
              </button>
            </div>
          </footer>
          {failed && (
            <p role="alert" className="draft-error">
              {view.problem ?? state.detail}
            </p>
          )}
          {copyHint && <p role="status">{copyHint}</p>}
        </>
      )}
    </main>
  );
}
