import { createHash } from "node:crypto";

// A bounded PTY replay can lose the original DEC mode setup. Recover only the
// input/screen modes from durable logs, without sending old text to the browser.
export class TerminalModes {
  private pending = "";
  private modes = new Map<string, string>();

  write(text: string) {
    const input = this.pending + text;
    this.pending = "";
    const pattern = /\x1bc|\x1b\[\?([\d;]+)([hl])/g;
    for (const match of input.matchAll(pattern)) {
      if (match[0] === "\x1bc") {
        this.modes.clear();
        continue;
      }
      for (const param of match[1].split(";")) {
        const mode = Number(param);
        const group = [47, 1047, 1049].includes(mode) ? "screen"
          : [9, 1000, 1002, 1003].includes(mode) ? "mouse"
          : [1005, 1006, 1016].includes(mode) ? "encoding"
          : [1, 1004, 1007, 2004].includes(mode) ? param : null;
        if (group) this.modes.set(group, `\x1b[?${mode}${match[2]}`);
      }
    }
    const partial = input.match(/\x1b(?:\[(?:\?[\d;]*)?)?$/);
    this.pending = partial && partial[0].length <= 128 ? partial[0] : "";
  }

  prefix() {
    const defaults = "\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[?1004l\x1b[?1007h\x1b[?2004l\x1b[?1l";
    return defaults + [...this.modes.values()].join("");
  }
}

type State = { modes: TerminalModes; after: number };
const states = new Map<string, Promise<State>>();

export async function terminalModePrefix(base: string, id: string, headers: { Authorization: string }) {
  const key = `${base}/${id}/${createHash("sha256").update(headers.Authorization).digest("hex")}`;
  const previous = states.get(key);
  const next = (async () => {
    const state = await previous?.catch(() => undefined) ?? { modes: new TerminalModes(), after: 0 };
    let until: number | null = null;
    while (true) {
      const params = new URLSearchParams({ after: String(state.after), limit: "1000" });
      if (until != null) params.set("until", String(until));
      const response = await fetch(`${base}/api/v1/sessions/${encodeURIComponent(id)}/logs?${params}`, {
        headers, signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`terminal state logs: HTTP ${response.status}`);
      const page = await response.json() as {
        lines: { id: number; content: string }[];
        snapshot_last_id: number | null;
        has_more: boolean;
      };
      until = page.snapshot_last_id;
      for (const line of page.lines) {
        state.modes.write(Buffer.from(line.content, "base64").toString("latin1"));
        state.after = line.id;
      }
      if (!page.has_more) return state;
      if (!page.lines.length) throw new Error("terminal state logs: empty page with has_more");
    }
  })();
  states.delete(key);
  states.set(key, next);
  if (states.size > 32) states.delete(states.keys().next().value!);
  const state = await next;
  return state.modes.prefix();
}
