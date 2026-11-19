import DOMPurify from 'dompurify';
import { useEffect, useRef, useState } from 'react';

export type DiagramFormat = 'Mermaid' | 'SVG' | 'HTML';

export function diagramFormat(language: string | undefined, text: string): DiagramFormat | undefined {
  switch (language?.trim().split(/\s+/)[0].toLowerCase()) {
    case 'mermaid': return 'Mermaid';
    case 'svg': return 'SVG';
    case 'html': return 'HTML';
    case 'xml': return /^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s>]/i.test(text) ? 'SVG' : undefined;
    case '':
    case undefined: return /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/.test(text) ? 'Mermaid' : undefined;
  }
}

// The frame is scriptless. Same-origin access lets Orbit size and populate it.
const previewDocument = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<style>
  html { background: #fff; color: #202734; font: 14px system-ui, sans-serif; }
  body { margin: 0; }
  #diagram-content { display: flow-root; padding: 12px; }
  #diagram-content[data-format="Mermaid"] > svg { display: block; margin: auto; }
  svg, img { max-width: 100%; }
  svg[viewBox], img { height: auto; }
</style></head><body></body></html>`;

let nextDiagramId = 0;
let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined;
async function renderMermaid(text: string) {
  mermaidModule ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'sandbox',
      suppressErrorRendering: true,
      htmlLabels: false,
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), 'htmlLabels', 'suppressErrorRendering', 'themeCSS'],
    });
    return mermaid;
  });
  const mermaid = await mermaidModule;
  const staging = document.createElement('div');
  // Mermaid measures the SVG inside its temporary iframe. Hiding the staging
  // element with display:none gives it an empty layout and clips the drawing.
  staging.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;visibility:hidden;pointer-events:none';
  staging.setAttribute('aria-hidden', 'true');
  document.body.append(staging);
  try {
    const { svg } = await mermaid.render(`orbit-diagram-${++nextDiagramId}`, text, staging);
    // Sandbox mode returns a data URL wrapping the drawn SVG. Extract the
    // markup without mounting its iframe so every preview uses our own CSP.
    const response = new DOMParser().parseFromString(svg, 'text/html');
    const src = response.querySelector('iframe')?.getAttribute('src') ?? '';
    const encoded = /^data:text\/html;charset=UTF-8;base64,([A-Za-z0-9+/=]+)$/.exec(src)?.[1];
    if (!encoded) throw new Error('Missing Mermaid diagram');
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
  } finally {
    staging.remove();
  }
}

export function CodexDiagram({ text, format }: { text: string; format: DiagramFormat }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const node = frame.current;
    const doc = node?.contentDocument;
    if (!loaded || !node || !doc) return;
    const preview = node;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    const container = doc.createElement('div');
    container.id = 'diagram-content';
    container.dataset.format = format;
    doc.body.replaceChildren(container);
    setStatus('loading');

    async function render() {
      const markup = format === 'Mermaid' ? await renderMermaid(text) : text;
      if (cancelled) return;
      const fragment = DOMPurify.sanitize(markup, {
        USE_PROFILES: { html: true, svg: true, svgFilters: true },
        FORCE_BODY: true,
        RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ['a', 'base', 'form', 'iframe', 'link', 'meta', 'object', 'embed', 'animate', 'set'],
        FORBID_ATTR: ['action', 'formaction', 'srcset', 'autofocus'],
      });
      if (format !== 'HTML' && !fragment.querySelector('svg')) throw new Error('Missing SVG');
      container.append(fragment);
      setStatus('ready');
      observer = new ResizeObserver(() => {
        preview.style.height = `${Math.min(560, Math.ceil(container.getBoundingClientRect().height))}px`;
      });
      observer.observe(container);
    }
    void render().catch(() => {
      if (!cancelled) setStatus('failed');
    });
    return () => { cancelled = true; observer?.disconnect(); container.remove(); };
  }, [loaded, text, format]);

  return <>
    {status !== 'ready' && <div className="codexDiagramStatus" role="status">
      {status === 'failed' ? 'Diagram could not be rendered. Open the source to view the original.' : 'Rendering diagram…'}
    </div>}
    <iframe ref={frame} className="codexDiagramPreview" title={`${format} preview`}
      data-ready={status === 'ready'} sandbox="allow-same-origin" srcDoc={previewDocument} onLoad={() => setLoaded(true)} />
  </>;
}
