import { writeFile } from 'node:fs/promises';

const findDocument = `function find(doc) {
  if (doc.querySelector('main[aria-label="Private local draft writer"]')) return doc;
  for (const frame of doc.querySelectorAll('iframe')) {
    try { const inner=frame.contentDocument; if(inner){const found=find(inner);if(found)return found;} } catch {}
  }
  return null;
}`;

// Browser input and accessibility inspection of the installed VSIX. This CDP
// endpoint exists only in the disposable test profile, never in the extension.
export class DraftBrowser {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly sessions = new Map<string, string>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  static async connect(): Promise<DraftBrowser> {
    const response = await fetch(
      `http://127.0.0.1:${process.env.CRW_HOST_DEBUG_PORT}/json/version`,
    );
    const info = (await response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Browser debugging connection failed')),
        { once: true },
      );
    });
    return new DraftBrowser(socket);
  }
  private send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command ${method} timed out`));
      }, 8000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  private async targets() {
    const result = await this.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>('Target.getTargets');
    const targets = result.targetInfos.filter(
      (target) => ['page', 'iframe'].includes(target.type) && !target.url.startsWith('devtools:'),
    );
    for (const target of targets)
      if (!this.sessions.has(target.targetId)) {
        const attached = await this.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        this.sessions.set(target.targetId, attached.sessionId);
      }
    return targets;
  }
  private async evaluate<T>(session: string, code: string): Promise<T> {
    const response = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      {
        expression: `(()=>{${findDocument};const doc=find(document);if(!doc)return null;${code}})()`,
        returnByValue: true,
        awaitPromise: true,
      },
      session,
    );
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  async writer<T>(code: string): Promise<T> {
    const deadline = Date.now() + 8000;
    do {
      for (const target of await this.targets()) {
        const session = this.sessions.get(target.targetId)!;
        try {
          const result = await this.evaluate<T>(session, code);
          if (result !== null) return result;
        } catch {
          this.sessions.delete(target.targetId);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    throw new Error('The installed writer did not render in a browser target.');
  }
  private async writerSession() {
    for (const target of await this.targets()) {
      const session = this.sessions.get(target.targetId)!;
      try {
        if (await this.evaluate(session, 'return true;')) return session;
      } catch {
        this.sessions.delete(target.targetId);
      }
    }
    throw new Error('The active writer browser target is unavailable.');
  }
  async insert(text: string) {
    await this.writer(
      `const field=doc.querySelector('textarea[aria-label="Private feedback"]');if(!field)return null;field.focus();field.setSelectionRange(field.value.length,field.value.length);return true;`,
    );
    await this.send('Input.insertText', { text }, await this.writerSession());
  }
  async click(name: string) {
    return this.writer(
      `const button=[...doc.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent).trim()===${JSON.stringify(name)});if(!button)return null;button.click();return true;`,
    );
  }
  async escape() {
    await this.writer(
      `doc.querySelector('textarea[aria-label="Private feedback"]')?.focus();return true;`,
    );
    const session = await this.writerSession();
    await this.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      session,
    );
    await this.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      session,
    );
  }
  async accessibility() {
    const session = await this.writerSession();
    interface Frame {
      frame: { id: string };
      childFrames?: Frame[];
    }
    type Nodes = { role?: { value: string }; name?: { value: string } }[];
    const tree = await this.send<{ frameTree: Frame }>('Page.getFrameTree', {}, session);
    const ids: string[] = [];
    function visit(frame: Frame) {
      ids.push(frame.frame.id);
      for (const child of frame.childFrames ?? []) visit(child);
    }
    visit(tree.frameTree);
    const nodes: Nodes = [];
    for (const frameId of ids) {
      const result = await this.send<{ nodes: Nodes }>(
        'Accessibility.getFullAXTree',
        { frameId },
        session,
      );
      nodes.push(...result.nodes);
    }
    return { nodes };
  }
  private async workbenchSession() {
    const page = (await this.targets()).find(
      (target) => target.type === 'page' && target.url.includes('workbench'),
    );
    if (!page) throw new Error('The native workbench browser page is unavailable.');
    return this.sessions.get(page.targetId)!;
  }
  async workbench<T>(code: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      { expression: `(()=>{${code}})()`, returnByValue: true },
      await this.workbenchSession(),
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async narrow(width?: number) {
    const page = (await this.targets()).find(
      (target) => target.type === 'page' && target.url.includes('workbench'),
    )!;
    if (!page) throw new Error('The native workbench page is unavailable.');
    await this.send(
      width ? 'Emulation.setDeviceMetricsOverride' : 'Emulation.clearDeviceMetricsOverride',
      width ? { width, height: 900, deviceScaleFactor: 1, mobile: false } : {},
      this.sessions.get(page.targetId),
    );
  }
  async screenshot(path: string) {
    const page = (await this.targets()).find(
      (target) => target.type === 'page' && target.url.includes('workbench'),
    )!;
    const result = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      this.sessions.get(page.targetId),
    );
    await writeFile(path, Buffer.from(result.data, 'base64'));
  }
  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser fixture closed'));
    }
    this.pending.clear();
    this.socket.close();
  }
}
