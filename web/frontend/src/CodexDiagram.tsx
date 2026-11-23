import DOMPurify from 'dompurify';
import { Maximize2, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useDialogHistory } from './dialog-history';
import { useDialogDismiss } from './dialog-dismiss';

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
  html { background: #fcfdff; color: #182741; font: 14px system-ui, sans-serif; overflow: hidden; }
  body { margin: 0; }
  #diagram-content { display: flow-root; padding: 12px; }
  #diagram-content[data-format="Mermaid"] > svg { display: block; margin: auto; }
  svg, img { max-width: 100%; }
  svg[viewBox], img { height: auto; }
  #diagram-content[data-zoomed="true"] > svg[viewBox] { width: 100%; max-width: none !important; }
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
      flowchart: { theme: 'base', look: 'neo', nodeSpacing: 36, rankSpacing: 42 },
      themeCSS: '.node > rect, .cluster > rect { rx: 8px; ry: 8px; } .flowchart-link { stroke-width: 1.5px; }',
      themeVariables: {
        fontFamily: 'system-ui, sans-serif',
        primaryColor: '#edf3ff',
        primaryTextColor: '#182741',
        primaryBorderColor: '#6988b7',
        lineColor: '#47648d',
        clusterBkg: '#f4f7fc',
        clusterBorder: '#b2c3db',
        edgeLabelBackground: '#fcfdff',
        tertiaryColor: '#f4f7fc',
        useGradient: false,
        gradientStart: '#6988b7',
        gradientStop: '#9bb0cf',
        filterColor: '#dce5f2',
      },
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

function DiagramFrame({ fragment, format, title, zoomed = false }: {
  fragment: DocumentFragment; format: DiagramFormat; title: string; zoomed?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useLayoutEffect(() => {
    const preview = frame.current;
    const doc = preview?.contentDocument;
    if (!loaded || !preview || !doc) return;
    const container = doc.createElement('div');
    container.id = 'diagram-content';
    container.dataset.format = format;
    container.dataset.zoomed = String(zoomed);
    container.append(fragment.cloneNode(true));
    doc.body.replaceChildren(container);

    const resize = () => {
      const { clientWidth, scrollWidth, scrollHeight } = container;
      if (!clientWidth) return;
      // Fixed-width HTML diagrams scale down to the available width.
      const scale = Math.min(1, clientWidth / Math.max(clientWidth, scrollWidth));
      container.style.transformOrigin = 'top left';
      container.style.transform = scale < 1 ? `scale(${scale})` : '';
      preview.style.height = `${Math.ceil(scrollHeight * scale)}px`;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => { observer.disconnect(); container.remove(); };
  }, [fragment, format, loaded, zoomed]);

  return <iframe ref={frame} className="codexDiagramPreview" title={title} tabIndex={-1}
    sandbox="allow-same-origin" srcDoc={previewDocument} onLoad={() => setLoaded(true)} />;
}

export function CodexDiagram({ text, format }: { text: string; format: DiagramFormat }) {
  const [result, setResult] = useState<DocumentFragment | 'failed'>();
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = () => { setOpen(false); setZoomed(false); };
  const dialogOpen = open && !!result && result !== 'failed';
  useDialogHistory(close, dialogOpen);
  const dismiss = useDialogDismiss(close);
  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!dialogOpen || !panel) return;
    panel.showModal();
    return () => panel.close();
  }, [dialogOpen]);

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
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
      setResult(fragment);
    }
    void render().catch(() => {
      if (!cancelled) setResult('failed');
    });
    return () => { cancelled = true; };
  }, [text, format]);

  if (!result || result === 'failed') return <div className="codexDiagramStatus" role="status">
    {result === 'failed' ? 'Diagram could not be rendered. Open the source to view the original.' : 'Rendering diagram…'}
  </div>;
  return <>
    <div className="codexDiagramCanvas">
      <DiagramFrame fragment={result} format={format} title={`${format} preview`} />
      <button type="button" className="codexDiagramOpen" aria-label={`Enlarge ${format} diagram`}
        aria-haspopup="dialog" title="Enlarge diagram" onClick={() => setOpen(true)}>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
    </div>
    {open && <dialog ref={dialog} className="codexDiagramDialog" aria-labelledby={titleId} {...dismiss}>
      <header>
        <strong id={titleId}>{format} diagram</strong>
        <button type="button" className="codexDiagramZoom" aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>
          {zoomed ? 'Fit width' : 'Zoom in'}
        </button>
        <button type="button" aria-label="Close diagram" onClick={close} autoFocus><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="codexDiagramViewport">
        <div className={zoomed ? 'codexDiagramZoomed' : undefined}>
          <DiagramFrame fragment={result} format={format} title={`Expanded ${format} preview`} zoomed={zoomed} />
        </div>
      </div>
    </dialog>}
  </>;
}
