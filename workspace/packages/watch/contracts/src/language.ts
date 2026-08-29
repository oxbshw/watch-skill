/**
 * Language-aware evidence.
 *
 * The correction this module encodes (spec §37): Watch is not an English
 * product with translations bolted on, and it is not an Arabic one either. It
 * is language-independent architecture with a *measured* support matrix — and
 * the two claims are very different. "Handles Unicode" is architecture.
 * "Reads Thai subtitles well" is a measurement, and it belongs to a
 * qualification result rather than to a type.
 *
 * Five things are kept separate that products routinely conflate:
 *
 * ```
 * UI locale            what the interface is in
 * source language(s)   what the material is in
 * script(s)            what alphabet it is written in
 * response language    what the agent answers in
 * translation target   an optional derived view
 * ```
 *
 * Changing the interface language must not translate evidence. A source can
 * contain several languages in one frame. And a translation is *derived data
 * with its own provenance* — the original text stays the evidence, because a
 * citation that resolved to a translation would be citing something no one
 * ever said.
 *
 * @module @watchskill/dsh-contracts/language
 */

/**
 * Which way a span reads.
 *
 * Per span, not per page. One frame can hold an Arabic sentence with a Latin
 * product name and a timestamp inside it, and a page-level direction would get
 * two of those three wrong.
 */
export type TextDirection = 'ltr' | 'rtl' | 'mixed' | 'unknown'

/** Unicode script identity, as the OCR and ASR contracts report it. */
export type ScriptTag =
  | 'Latin' | 'Arabic' | 'Hebrew' | 'Cyrillic' | 'Greek'
  | 'Han' | 'Hiragana' | 'Katakana' | 'Hangul'
  | 'Devanagari' | 'Thai' | 'Lao' | 'Khmer' | 'Myanmar' | 'Tibetan'
  | 'Unknown'

/** Scripts that are written right to left. */
const RTL_SCRIPTS = new Set<ScriptTag>(['Arabic', 'Hebrew'])

/**
 * Detect the scripts present in a string.
 *
 * Range-based rather than library-based on purpose: this runs on the browser
 * side of an evidence panel, and pulling a full ICU table into a bundle to
 * answer "is there Arabic in here" is not a trade worth making. It is
 * deliberately coarse — it reports which scripts appear, which is what
 * direction and routing need, not a language identification.
 */
export function detectScripts(text: string): readonly ScriptTag[] {
  const found = new Set<ScriptTag>()
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    // Skip anything that carries no script identity: digits, punctuation,
    // whitespace. Counting them would make every string "Latin".
    if (code < 0x0041) continue
    if (code <= 0x024f) found.add('Latin')
    else if (code >= 0x0370 && code <= 0x03ff) found.add('Greek')
    else if (code >= 0x0400 && code <= 0x04ff) found.add('Cyrillic')
    else if (code >= 0x0590 && code <= 0x05ff) found.add('Hebrew')
    else if (code >= 0x0600 && code <= 0x06ff) found.add('Arabic')
    else if (code >= 0x0750 && code <= 0x077f) found.add('Arabic')
    else if (code >= 0x0900 && code <= 0x097f) found.add('Devanagari')
    else if (code >= 0x0e00 && code <= 0x0e7f) found.add('Thai')
    else if (code >= 0x0e80 && code <= 0x0eff) found.add('Lao')
    else if (code >= 0x0f00 && code <= 0x0fff) found.add('Tibetan')
    else if (code >= 0x1000 && code <= 0x109f) found.add('Myanmar')
    else if (code >= 0x1780 && code <= 0x17ff) found.add('Khmer')
    else if (code >= 0x3040 && code <= 0x309f) found.add('Hiragana')
    else if (code >= 0x30a0 && code <= 0x30ff) found.add('Katakana')
    else if (code >= 0x4e00 && code <= 0x9fff) found.add('Han')
    else if (code >= 0xac00 && code <= 0xd7af) found.add('Hangul')
    else if (code >= 0xfb50 && code <= 0xfdff) found.add('Arabic')
    else if (code >= 0xfe70 && code <= 0xfeff) found.add('Arabic')
  }
  return found.size === 0 ? ['Unknown'] : [...found].sort()
}

/**
 * Which way a string reads.
 *
 * `mixed` is a real answer, not a failure to decide. A layout that renders
 * mixed content as though it were uniformly one direction produces text that
 * is technically present and unreadable.
 */
export function detectDirection(text: string): TextDirection {
  const scripts = detectScripts(text)
  if (scripts.length === 1 && scripts[0] === 'Unknown') return 'unknown'
  const hasRtl = scripts.some(script => RTL_SCRIPTS.has(script))
  const hasLtr = scripts.some(script => script !== 'Unknown' && !RTL_SCRIPTS.has(script))
  if (hasRtl && hasLtr) return 'mixed'
  if (hasRtl) return 'rtl'
  return 'ltr'
}

/**
 * A translation of an evidence span.
 *
 * Derived data with its own provenance, deliberately shaped so it can never be
 * mistaken for the original: it names the engine that produced it and carries
 * no evidence id of its own.
 */
export interface DerivedTranslation {
  readonly targetLanguage: string
  readonly text: string
  readonly engine: string
  readonly engineVersion: string
  readonly translatedAt: string
  /** Null unless the engine produces a calibrated score. */
  readonly confidence: number | null
}

/**
 * The language-aware text of one piece of evidence.
 *
 * `originalText` is the evidence. Everything else is a view of it.
 */
export interface LanguageAwareText {
  /**
   * Exactly what was observed, byte for byte.
   *
   * The evidence authority. Never normalized in place, never replaced by a
   * translation, and what a citation resolves to.
   */
  readonly originalText: string
  /**
   * A folded form for retrieval only.
   *
   * Case-folded, diacritic-stripped, width-normalized — whatever the index
   * needs to match a query someone typed differently from how it appears.
   * Never displayed, never cited, and never the thing a verdict is about.
   */
  readonly normalizedText: string | null
  /** BCP-47 tags where known. Empty rather than guessed. */
  readonly languageTags: readonly string[]
  readonly scripts: readonly ScriptTag[]
  readonly direction: TextDirection
  /** Null unless the detector is calibrated. */
  readonly languageConfidence: number | null
  readonly producer: string
  readonly producerVersion: string
  /** Derived views. A citation never resolves to one of these. */
  readonly translations: readonly DerivedTranslation[]
  readonly qualityWarnings: readonly string[]
}

/**
 * Normalize text for retrieval.
 *
 * NFKC plus case folding plus combining-mark removal: enough that a query
 * typed without diacritics finds text written with them, and that half-width
 * and full-width forms match. Deliberately not stemming or transliteration —
 * those change what a word means, and an index that matched across them would
 * return hits a person cannot see the reason for.
 */
export function normalizeForRetrieval(text: string): string {
  return text
    // NFKD, not NFKC. Compatibility *decomposition* is what separates a
    // precomposed É into E plus a combining acute so the next step can remove
    // it; NFKC would compose it back into one codepoint that matches no
    // combining-mark pattern, and the diacritic would survive the fold.
    .normalize('NFKD')
    .toLowerCase()
    // Strip combining marks. This folds Arabic and Hebrew vowel points and
    // Latin accents alike, which is what makes a query match text that was
    // written more carefully than it was typed.
    .replace(/\p{M}+/gu, '')
    // Recompose. NFKD also splits Hangul syllables into jamo, and leaving them
    // apart would mean composed and decomposed Korean no longer match each
    // other — the exact failure this function exists to prevent.
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Build the language-aware text for an observed span.
 *
 * The normalized form is computed here rather than accepted from a caller, so
 * every index in the product folds text the same way. Two normalizers that
 * disagree produce a search that finds a result in one surface and not in
 * another, for reasons nobody can see.
 */
export function describeText(
  originalText: string,
  producer: string,
  producerVersion: string,
  options: {
    readonly languageTags?: readonly string[]
    readonly languageConfidence?: number | null
    readonly qualityWarnings?: readonly string[]
  } = {},
): LanguageAwareText {
  return {
    originalText,
    normalizedText: normalizeForRetrieval(originalText),
    languageTags: options.languageTags ?? [],
    scripts: detectScripts(originalText),
    direction: detectDirection(originalText),
    languageConfidence: options.languageConfidence ?? null,
    producer,
    producerVersion,
    translations: [],
    qualityWarnings: options.qualityWarnings ?? [],
  }
}

/**
 * Attach a translation without disturbing the original.
 *
 * Returns a new value. The original text is unchanged and stays first, because
 * the moment a translation could overwrite it, a citation would resolve to
 * something nobody said.
 */
export function withTranslation(
  text: LanguageAwareText,
  translation: DerivedTranslation,
): LanguageAwareText {
  return { ...text, translations: [...text.translations, translation] }
}

/**
 * What a surface should display, given a reader's preference.
 *
 * Returns the original unless a translation for the requested language exists,
 * and always says which it returned. A caller that renders this without
 * showing `isOriginal` is presenting derived text as observed text.
 */
export function displayText(
  text: LanguageAwareText,
  preferredLanguage: string | null,
): { readonly text: string; readonly isOriginal: boolean; readonly direction: TextDirection } {
  if (preferredLanguage === null) {
    return { text: text.originalText, isOriginal: true, direction: text.direction }
  }
  const translation = text.translations.find(entry => entry.targetLanguage === preferredLanguage)
  if (translation === undefined) {
    return { text: text.originalText, isOriginal: true, direction: text.direction }
  }
  return {
    text: translation.text,
    isOriginal: false,
    // The translation's own direction, not the original's: rendering Arabic
    // output with the source's ltr direction produces unreadable text.
    direction: detectDirection(translation.text),
  }
}

/**
 * Whether a span must be isolated from the surrounding text direction.
 *
 * Code, URLs, identifiers and timestamps read left to right inside an
 * otherwise right-to-left paragraph, and without isolation the bidi algorithm
 * reorders them into something that looks plausible and is wrong — a path with
 * its segments reversed, a timestamp reading 30:2.
 */
export function needsDirectionIsolation(kind: string): boolean {
  return ['code', 'url', 'path', 'identifier', 'timestamp', 'digest', 'version'].includes(kind)
}
