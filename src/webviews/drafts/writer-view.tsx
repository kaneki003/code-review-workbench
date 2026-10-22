import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import MarkdownIt from 'markdown-it';
import type { DraftWriterClient } from './client';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]!.content);

const button =
  'rounded-[5px] border border-outline bg-secondary px-2.5 py-[5px] text-foreground hover:enabled:bg-secondary-hover disabled:cursor-default disabled:opacity-60';
const tab =
  'rounded-t-[5px] border border-transparent bg-transparent px-3 py-[7px] text-foreground';
const selectedTab =
  'rounded-t-[5px] border border-outline border-b-surface bg-surface px-3 py-[7px] text-foreground -mb-px';
const formatButton =
  'rounded-[5px] border border-transparent bg-transparent px-2 py-[3px] text-foreground max-[500px]:px-[5px] disabled:opacity-60';
const inputStyle =
  'block w-full min-h-[105px] resize-y rounded-none border-0 bg-input p-3 text-input-text font-interface [font-size:inherit] leading-normal placeholder:text-placeholder';

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
      className="draft-writer box-border mx-auto max-w-[1100px] px-[18px] py-3.5 font-interface [&_*]:box-border max-[500px]:p-2.5"
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
        <section
          className="mb-3 border border-warning p-2.5"
          aria-label="Unacknowledged input recovery"
        >
          <p>
            Input from {view.recovery.label} was not confirmed before the view changed. Copy it
            before closing this recovery copy.
          </p>
          <textarea
            className={inputStyle}
            aria-label="Recovery copy of private feedback"
            value={view.recovery.body}
            readOnly
          />
          <button className={button} onClick={() => client.dismissRecovery()}>
            Close recovery copy
          </button>
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
          <header className="mb-2.5 [overflow-wrap:anywhere] [&>div]:flex [&>div]:flex-wrap [&>div]:items-baseline [&>div]:gap-x-3 [&>div]:gap-y-1.5">
            <div>
              <span className="rounded-xl border border-outline px-[7px] py-px text-[0.85em] text-link">
                Local draft
              </span>
              <span>PR #{state.review.pullNumber}</span>
              <strong>{state.target.anchor.path}</strong>
            </div>
            <div className="mt-[5px] text-[0.9em] text-muted">
              <span>
                {state.target.anchor.side === 'old' ? 'Original' : 'New'} · L
                {state.target.anchor.range.startLine + 1}:
                {state.target.anchor.range.startCharacter + 1}–L
                {state.target.anchor.range.endLine + 1}:{state.target.anchor.range.endCharacter + 1}
              </span>
              <code
                className="font-code text-[0.9em] [overflow-wrap:anywhere]"
                title={state.target.anchor.commit}
              >
                {state.target.anchor.commit}
              </code>
            </div>
          </header>
          <section
            className="overflow-hidden rounded-[7px] border border-outline bg-surface"
            aria-label="Feedback composition"
          >
            <div
              className="flex items-center gap-1 border-b border-outline bg-widget px-2 pt-[5px]"
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
                className={preview ? tab : selectedTab}
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
                className={preview ? selectedTab : tab}
                id="draft-preview-tab"
                role="tab"
                aria-selected={preview}
                aria-controls="draft-body"
                tabIndex={preview ? 0 : -1}
                onClick={() => setPreview(true)}
              >
                Preview
              </button>
              <span className="ml-auto flex gap-[3px] pb-1" aria-label="Markdown formatting">
                <button
                  className={formatButton}
                  aria-label="Bold"
                  title="Bold"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('**')}
                >
                  <b>B</b>
                </button>
                <button
                  className={formatButton}
                  aria-label="Italic"
                  title="Italic"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('_')}
                >
                  <i>I</i>
                </button>
                <button
                  className={formatButton}
                  aria-label="Code"
                  title="Code"
                  disabled={preview || busy || Boolean(view.recovery)}
                  onClick={() => format('`')}
                >
                  {'<>'}
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
                  className="draft-preview min-h-[105px] px-3 py-2.5 [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&_pre]:whitespace-pre-wrap [&_pre]:bg-code [&_pre]:p-2 [&_a]:text-link"
                  dangerouslySetInnerHTML={{
                    __html: markdown.render(view.body || '*Nothing to preview.*'),
                  }}
                />
              ) : (
                <textarea
                  className={inputStyle}
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
            <div className="border-t border-outline px-3 py-[5px] text-[0.85em] text-muted">
              Markdown supported
            </div>
          </section>
          <footer className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 max-[500px]:items-stretch">
            <div>
              <div id="draft-save-state" role="status" aria-live="polite">
                {status}
              </div>
              <div id="draft-private-note" className="mt-[3px] text-[0.85em] text-muted">
                Private on this device · Not sent to GitHub
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 max-[500px]:w-full">
              {failed && (
                <>
                  <button className={button} onClick={() => void copy()}>
                    Copy input
                  </button>
                  <button
                    className="rounded-[5px] border border-outline bg-action px-2.5 py-[5px] text-action-text disabled:opacity-60"
                    disabled={busy}
                    onClick={() => client.control('retry')}
                  >
                    Retry
                  </button>
                </>
              )}
              <button className={button} disabled={busy} onClick={() => client.control('close')}>
                {view.action === 'close' ? 'Saving before Close…' : 'Close'}
              </button>
              <button
                className="rounded-[5px] border border-outline bg-transparent px-2.5 py-[5px] text-error disabled:opacity-60"
                disabled={busy}
                onClick={() => client.control('discard')}
              >
                Discard draft
              </button>
            </div>
          </footer>
          {failed && (
            <p role="alert" className="text-error [overflow-wrap:anywhere]">
              {view.problem ?? state.detail}
            </p>
          )}
          {copyHint && <p role="status">{copyHint}</p>}
        </>
      )}
    </main>
  );
}
