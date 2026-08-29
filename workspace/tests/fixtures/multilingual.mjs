/**
 * The same observation, in six writing systems.
 *
 * Each fixture is a real sentence in a real script rather than lorem text,
 * because the failures this suite exists to catch are all specific to real
 * writing: an Arabic string that survives a round trip with its diacritics
 * stripped, a Devanagari string whose combining marks were separated, a
 * Chinese string measured as twice its length because somebody counted UTF-16
 * units, a mixed-script line where the Latin fragment reordered the Arabic
 * around it.
 *
 * Every entry carries the same evidence: the exact text, the scripts it uses,
 * the direction it reads in, and — for one of them — a translation, which is
 * derived and must never be what a citation resolves to.
 */

/** One source of truth per script. */
export const SAMPLES = [
  {
    id: 'latin',
    label: 'English / Latin',
    text: 'Deploy succeeded at 12:30, and the health check is green.',
    scripts: ['Latin'],
    direction: 'ltr',
    languageTags: ['en'],
    // A fragment that has to survive verbatim through indexing and citation.
    needle: 'health check is green',
  },
  {
    id: 'arabic',
    label: 'Arabic / RTL',
    // Fully vocalised on purpose: the diacritics are the part a careless
    // normalization drops, and dropping them changes the word.
    text: 'تَمَّ النَّشْرُ بِنَجاحٍ في الساعة 12:30، وفحص السلامة أخضر.',
    scripts: ['Arabic'],
    direction: 'rtl',
    languageTags: ['ar'],
    needle: 'تَمَّ النَّشْرُ',
  },
  {
    id: 'han',
    label: 'Chinese / Han',
    text: '部署成功，健康检查为绿色。',
    // `Han`, not `Han_Simplified`: see the note in multilingual.test.mjs.
    // Range-based detection cannot tell the two apart, and reporting a
    // distinction it cannot make would be worse than reporting the script.
    scripts: ['Han'],
    direction: 'ltr',
    languageTags: ['zh-Hans'],
    needle: '健康检查',
  },
  {
    id: 'cyrillic',
    label: 'Russian / Cyrillic',
    text: 'Развёртывание прошло успешно, проверка состояния зелёная.',
    scripts: ['Cyrillic'],
    direction: 'ltr',
    languageTags: ['ru'],
    // Carries a ё, which a naïve fold turns into е — a different letter.
    needle: 'Развёртывание',
  },
  {
    id: 'devanagari',
    label: 'Hindi / Devanagari',
    text: 'तैनाती सफल रही, और स्वास्थ्य जाँच हरी है।',
    scripts: ['Devanagari'],
    direction: 'ltr',
    languageTags: ['hi'],
    needle: 'स्वास्थ्य जाँच',
  },
  {
    id: 'mixed',
    label: 'Mixed script',
    // The hard case: Latin identifiers and a timestamp inside Arabic prose.
    // Without isolation the bidi algorithm reorders the run around them.
    text: 'فشل الطلب POST /api/v2/deploy عند 12:30 مع رمز 500.',
    scripts: ['Arabic', 'Latin'],
    direction: 'mixed',
    languageTags: ['ar'],
    needle: '/api/v2/deploy',
  },
]

/** Build a language-aware evidence text for one sample. */
export function evidenceTextFor(sample, extras = {}) {
  return {
    originalText: sample.text,
    normalizedText: null,
    languageTags: sample.languageTags,
    scripts: sample.scripts,
    direction: sample.direction,
    languageConfidence: null,
    producer: 'watch-core',
    producerVersion: '1.3.0rc2',
    translations: [],
    qualityWarnings: [],
    ...extras,
  }
}

/** A derived English translation of the Arabic sample. */
export const ARABIC_TRANSLATION = {
  targetLanguage: 'en',
  text: 'The deployment succeeded at 12:30, and the health check is green.',
  engine: 'example-translator',
  engineVersion: '1.0',
  translatedAt: '2026-08-28T10:00:00.000Z',
  confidence: null,
}

/** The spans inside the mixed sample that must be isolated when rendered. */
export const MIXED_ISOLATED_SPANS = [
  { kind: 'identifier', text: 'POST' },
  { kind: 'path', text: '/api/v2/deploy' },
  { kind: 'timestamp', text: '12:30' },
]
