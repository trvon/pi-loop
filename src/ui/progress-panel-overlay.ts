import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipPanelText, layoutProgressPanel, type PanelLine, type ProgressPanelInput } from "./progress-panel.js";

/**
 * Docks the in-progress panel as a narrow column at the top-right of the
 * terminal. It never captures focus, hides itself on narrow terminals, and
 * unmounts when nothing is in progress, so it does not compete with the
 * transcript or the editor.
 */

export type ProgressPanelMode = "auto" | "off";

export const PANEL_WIDTH = 36;
export const PANEL_MIN_TERMINAL_WIDTH = 110;
export const PANEL_MAX_ROWS = 18;
const BORDER_WIDTH = 2;
const TITLE = "pi-loop";

export function resolveProgressPanelMode(value: string | undefined): ProgressPanelMode {
  return value?.trim().toLowerCase() === "off" ? "off" : "auto";
}

function styleLine(theme: Theme, line: PanelLine, inner: number): string {
  let used = 0;
  let text = "";
  for (const segment of line) {
    used += visibleWidth(segment.text);
    text += theme.fg(segment.tone, segment.text);
  }
  // Padding keeps transcript text from bleeding through ragged line ends.
  return theme.fg("dim", "│ ") + text + " ".repeat(Math.max(0, inner - used));
}

// Snapshots are immutable and replaced on every sync, so identity is a sound
// cache key. One frame otherwise lays out three times (sync, visibility, render).
let cachedLayout: { input: ProgressPanelInput; inner: number; body: PanelLine[] } | undefined;

function panelBody(input: ProgressPanelInput, inner: number): PanelLine[] {
  if (cachedLayout?.input === input && cachedLayout.inner === inner) return cachedLayout.body;
  const body = layoutProgressPanel(input, inner, PANEL_MAX_ROWS);
  cachedLayout = { input, inner, body };
  return body;
}

function rule(prefix: string, width: number): string {
  const fill = width - visibleWidth(prefix);
  return fill >= 0 ? prefix + "─".repeat(fill) : clipPanelText(prefix, width, "");
}

/** Themed frame around the pure layout; exported for width/height tests. */
export function renderProgressPanel(theme: Theme, input: ProgressPanelInput | undefined, width: number): string[] {
  if (!input) return [];
  const inner = width - BORDER_WIDTH;
  const body = panelBody(input, inner);
  if (body.length === 0) return [];
  return [
    theme.fg("dim", rule(`╭─ ${TITLE} `, width)),
    ...body.map((line) => styleLine(theme, line, inner)),
    theme.fg("dim", rule("╰", width)),
  ];
}

export function progressPanelHasContent(input: ProgressPanelInput | undefined): boolean {
  return input !== undefined && panelBody(input, PANEL_WIDTH - BORDER_WIDTH).length > 0;
}

interface RenderRequester {
  requestRender(): void;
}

export class ProgressPanelOverlay {
  private ui: ExtensionUIContext | undefined;
  private input: ProgressPanelInput | undefined;
  private tui: RenderRequester | undefined;
  private close: (() => void) | undefined;
  // Fences a late factory/close callback from a previous mount or UI.
  private mountToken = 0;
  private mounted = false;

  constructor(private mode: ProgressPanelMode = "auto") {}

  getMode(): ProgressPanelMode {
    return this.mode;
  }

  setMode(mode: ProgressPanelMode): void {
    this.mode = mode;
    if (mode === "off") this.unmount();
    else this.sync(this.input);
  }

  setUI(ui: ExtensionUIContext): void {
    if (ui === this.ui) return;
    this.unmount();
    this.ui = ui;
  }

  /** Stores the latest read-only snapshot and mounts, repaints, or unmounts. */
  sync(input: ProgressPanelInput | undefined): void {
    this.input = input;
    if (this.mode === "off" || !this.ui) return;
    if (!progressPanelHasContent(input)) {
      this.unmount();
      return;
    }
    if (!this.mounted) {
      this.mount(this.ui);
      return;
    }
    try {
      this.tui?.requestRender();
    } catch {
      // A stale UI after session switch must not break the caller's mutation path.
      this.unmount();
    }
  }

  dispose(): void {
    this.unmount();
    this.input = undefined;
  }

  private mount(ui: ExtensionUIContext): void {
    if (typeof ui.custom !== "function") return;
    const token = ++this.mountToken;
    this.mounted = true;
    try {
      void ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          if (token === this.mountToken) {
            this.tui = tui;
            this.close = () => done();
          } else {
            queueMicrotask(() => done());
          }
          return {
            // A render error must never escape into the host TUI loop.
            render: (width: number) => {
              try {
                return renderProgressPanel(theme, token === this.mountToken ? this.input : undefined, width);
              } catch {
                return [];
              }
            },
            invalidate: () => {},
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: PANEL_WIDTH,
            margin: { top: 1, right: 1 },
            maxHeight: "70%",
            nonCapturing: true,
            visible: (termWidth) => termWidth >= PANEL_MIN_TERMINAL_WIDTH && progressPanelHasContent(this.input),
          },
        },
      ).then(
        () => this.released(token),
        () => this.released(token),
      );
    } catch {
      this.released(token);
    }
  }

  private released(token: number): void {
    if (token !== this.mountToken) return;
    this.mounted = false;
    this.tui = undefined;
    this.close = undefined;
  }

  private unmount(): void {
    const close = this.close;
    this.mountToken++;
    this.mounted = false;
    this.tui = undefined;
    this.close = undefined;
    try {
      close?.();
    } catch {
      // Closing through a stale UI is best-effort.
    }
  }
}
