import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef } from "react";
import { fetchWorkspaceImage } from "./workspace-images";

const fileOrigin = "https://orbit-files.invalid";

export function FileMarkdownPreview({ source, path, server, token }: {
  source: string;
  path: string;
  server: string;
  token: string;
}) {
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = preview.current;
    if (!container || !DOMPurify.isSupported) return;

    const base = new URL(path.split("/").map(encodeURIComponent).join("/"), fileOrigin);
    const fragment = DOMPurify.sanitize(marked.parse(source, { async: false }), {
      USE_PROFILES: { html: true },
      RETURN_DOM_FRAGMENT: true,
      FORBID_ATTR: ["srcset"],
    });
    const controller = new AbortController();
    const objectUrls: string[] = [];

    for (const image of fragment.querySelectorAll("img[src]")) {
      const src = image.getAttribute("src")?.trim() || "";
      if (/^(https?:\/\/|\/\/|data:image\/)/i.test(src)) continue;

      image.removeAttribute("src");
      if (!src || src.startsWith("#")) continue;

      void (async () => {
        try {
          const file = new URL(src, base);
          if (file.origin !== fileOrigin) return;
          const blob = await fetchWorkspaceImage(decodeURIComponent(file.pathname), server, token, controller.signal);
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          image.setAttribute("src", url + file.hash);
        } catch {
          // Keep the image's alternate text when a preview is unavailable.
        }
      })();
    }

    container.replaceChildren(fragment);
    return () => {
      controller.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [source, path, server, token]);

  return <div className="fileMarkdownPreview" ref={preview} />;
}
