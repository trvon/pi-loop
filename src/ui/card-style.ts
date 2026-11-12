/**
 * Glyphs for collapsed tool cards. There is one card style; only the glyph set
 * varies with what the terminal can draw. Colors always come from the active
 * pi theme tokens, so custom themes apply unchanged.
 */

export type GlyphTier = "nerd" | "unicode" | "ascii";

export interface CardGlyphs {
  /** Between states in the trail. */
  hop: string;
  /** Prefix for a state that has been entered before. */
  visited: string;
  /** Wraps the current state. */
  currentOpen: string;
  currentClose: string;
  /** Between fields (trail, activity, attempt, outcomes) and roster items. */
  field: string;
  /** Introduces the available outcomes. */
  next: string;
  outcomeJoin: string;
  taskActive: string;
  taskPending: string;
  ellipsis: string;
}

// Box-drawing, basic geometric shapes, and Latin-1 only: these are present in
// effectively every monospace font, unlike dingbat or supplemental arrows.
const UNICODE: CardGlyphs = {
  hop: " ▸ ",
  visited: "✓",
  currentOpen: "[",
  currentClose: "]",
  field: " │ ",
  next: "» ",
  outcomeJoin: "|",
  taskActive: "■",
  taskPending: "□",
  ellipsis: "…",
};

// Private-use icons are accents only; structure (brackets, separators) stays
// in portable characters so a missing glyph never hides the current state.
const NERD: CardGlyphs = {
  ...UNICODE,
  hop: " \ue0b1 ",
  visited: "\uf00c ",
  next: "\uf061 ",
  taskActive: "\uf111 ",
  taskPending: "\uf10c ",
};

const ASCII: CardGlyphs = {
  ...UNICODE,
  hop: " > ",
  visited: "+",
  field: " | ",
  next: ">> ",
  taskActive: "*",
  taskPending: "-",
  ellipsis: "...",
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Fonts cannot be queried from a terminal, and a missing private-use glyph
 * renders as a blank, so Nerd Font icons are opt-in only (`PI_LOOP_GLYPHS=nerd`
 * or `NERD_FONT=1`). Otherwise the locale decides between Unicode and ASCII.
 */
export function detectGlyphTier(env: Env = process.env): GlyphTier {
  const explicit = env.PI_LOOP_GLYPHS?.trim().toLowerCase();
  if (explicit === "nerd" || explicit === "unicode" || explicit === "ascii") return explicit;

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (env.TERM === "dumb" || env.TERM === "linux" || !/utf-?8/i.test(locale)) return "ascii";
  return env.NERD_FONT === "1" ? "nerd" : "unicode";
}

export function parseGlyphTier(value: string | undefined): GlyphTier | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "nerd" || normalized === "unicode" || normalized === "ascii" ? normalized : undefined;
}

export function cardGlyphs(tier: GlyphTier): CardGlyphs {
  return tier === "nerd" ? NERD : tier === "ascii" ? ASCII : UNICODE;
}

let activeTier: GlyphTier = "unicode";

/** Process-wide glyph set; set once at activation and by `/loop glyphs`. */
export function setGlyphTier(tier: GlyphTier): void {
  activeTier = tier;
}

export function getGlyphTier(): GlyphTier {
  return activeTier;
}

export function activeCardGlyphs(): CardGlyphs {
  return cardGlyphs(activeTier);
}
