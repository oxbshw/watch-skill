/**
 * Language-aware evidence.
 *
 * The rule under test is one sentence: **the original text is the evidence.**
 * Normalization is for finding things, translation is a view, and a citation
 * resolves to neither — because a citation that resolved to a translation
 * would be citing something nobody ever said.
 *
 * The script and direction cases use real text in each script rather than
 * placeholder strings, because the failures worth catching here are the ones
 * where a range is off by a block and an entire writing system is reported as
 * `Unknown`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeText,
  detectDirection,
  detectScripts,
  displayText,
  needsDirectionIsolation,
  normalizeForRetrieval,
  withTranslation,
} from '@deepwatch/dsh-contracts'

describe('script detection', () => {
  test('recognizes each writing system the matrix names', () => {
    const cases = [
      ['the build failed', 'Latin'],
      ['فشل البناء', 'Arabic'],
      ['הבנייה נכשלה', 'Hebrew'],
      ['сборка не удалась', 'Cyrillic'],
      ['η κατασκευή απέτυχε', 'Greek'],
      ['构建失败', 'Han'],
      ['ビルドが失敗', 'Katakana'],
      ['빌드 실패', 'Hangul'],
      ['निर्माण विफल', 'Devanagari'],
      ['การสร้างล้มเหลว', 'Thai'],
    ]
    for (const [text, expected] of cases) {
      assert.ok(
        detectScripts(text).includes(expected),
        `${expected} not detected in ${JSON.stringify(text)} — got ${detectScripts(text).join(', ')}`,
      )
    }
  })

  test('a mixed frame reports every script in it', () => {
    // One frame really does hold an Arabic sentence with a Latin product name
    // inside it, and reporting only one of them loses the other.
    const scripts = detectScripts('خطأ في TypeScript عند 2:14')
    assert.ok(scripts.includes('Arabic'))
    assert.ok(scripts.includes('Latin'))
  })

  test('digits and punctuation alone carry no script identity', () => {
    // Counting them would make every string Latin, including a pure timestamp.
    assert.deepEqual(detectScripts('12:34 — (5)'), ['Unknown'])
    assert.deepEqual(detectScripts(''), ['Unknown'])
  })
})

describe('direction', () => {
  test('right-to-left scripts read right to left', () => {
    assert.equal(detectDirection('فشل البناء'), 'rtl')
    assert.equal(detectDirection('הבנייה נכשלה'), 'rtl')
  })

  test('mixed is a real answer, not a failure to decide', () => {
    // A layout that renders mixed content as uniformly one direction produces
    // text that is technically present and unreadable.
    assert.equal(detectDirection('خطأ في TypeScript'), 'mixed')
  })

  test('a string with no script is unknown, not ltr', () => {
    assert.equal(detectDirection('12:34'), 'unknown')
  })
})

describe('the original text is the evidence', () => {
  test('normalization never replaces the original', () => {
    const arabic = 'فَشِلَ البِناء'
    const described = describeText(arabic, 'watch-core', '1.3.0')
    assert.equal(described.originalText, arabic, 'the original must survive byte for byte')
    assert.notEqual(described.normalizedText, arabic)
    assert.equal(described.direction, 'rtl')
    assert.ok(described.scripts.includes('Arabic'))
  })

  test('a translation is derived and does not displace the original', () => {
    const described = withTranslation(
      describeText('فشل البناء', 'watch-core', '1.3.0', { languageTags: ['ar'] }),
      {
        targetLanguage: 'en',
        text: 'the build failed',
        engine: 'some-translator',
        engineVersion: '1.0',
        translatedAt: '2026-08-27T00:00:00.000Z',
        confidence: null,
      },
    )
    assert.equal(described.originalText, 'فشل البناء')
    assert.equal(described.translations.length, 1)
    // The translation names its own producer, so it can never be mistaken for
    // something the engine observed.
    assert.equal(described.translations[0].engine, 'some-translator')
    assert.notEqual(described.translations[0].engine, described.producer)
  })

  test('displaying a translation says that is what it is', () => {
    const described = withTranslation(
      describeText('فشل البناء', 'watch-core', '1.3.0'),
      {
        targetLanguage: 'en',
        text: 'the build failed',
        engine: 't',
        engineVersion: '1',
        translatedAt: '2026-08-27T00:00:00.000Z',
        confidence: null,
      },
    )

    const original = displayText(described, null)
    assert.equal(original.isOriginal, true)
    assert.equal(original.text, 'فشل البناء')
    assert.equal(original.direction, 'rtl')

    const translated = displayText(described, 'en')
    assert.equal(translated.isOriginal, false)
    assert.equal(translated.text, 'the build failed')
    // The translation's own direction. Rendering English output right-to-left
    // because the source was Arabic produces unreadable text.
    assert.equal(translated.direction, 'ltr')
  })

  test('asking for a language with no translation returns the original', () => {
    const described = describeText('فشل البناء', 'watch-core', '1.3.0')
    const shown = displayText(described, 'fr')
    assert.equal(shown.isOriginal, true)
    assert.equal(shown.text, 'فشل البناء')
  })

  test('language tags are empty rather than guessed', () => {
    // Detecting a script is not identifying a language, and reporting one we
    // did not establish is the same error as reporting a fabricated verdict.
    assert.deepEqual(describeText('hello', 'p', '1').languageTags, [])
    assert.equal(describeText('hello', 'p', '1').languageConfidence, null)
  })
})

describe('normalization is for finding, not for showing', () => {
  test('it folds case, width and diacritics', () => {
    assert.equal(normalizeForRetrieval('CAFÉ'), 'cafe')
    // Full-width forms fold to their ASCII equivalents, so a query typed on a
    // Latin keyboard finds text entered on a CJK one.
    assert.equal(normalizeForRetrieval('ＴｙｐｅＳｃｒｉｐｔ'), 'typescript')
  })

  test('it folds Arabic vowel points', () => {
    // A query typed without harakat should find text written with them.
    assert.equal(normalizeForRetrieval('فَشِلَ'), normalizeForRetrieval('فشل'))
  })

  test('it collapses whitespace without changing words', () => {
    assert.equal(normalizeForRetrieval('  the   build \n failed '), 'the build failed')
  })

  test('it does not stem or transliterate', () => {
    // Those change what a word means, and an index matching across them would
    // return hits nobody can see the reason for.
    assert.notEqual(normalizeForRetrieval('running'), normalizeForRetrieval('run'))
    assert.notEqual(normalizeForRetrieval('فشل'), 'fashal')
  })
})

describe('direction isolation', () => {
  test('code, paths, URLs and timestamps are isolated', () => {
    // Without isolation the bidi algorithm reorders these inside a
    // right-to-left paragraph into something plausible and wrong — a path with
    // its segments reversed, a timestamp reading 30:2.
    for (const kind of ['code', 'url', 'path', 'identifier', 'timestamp', 'digest', 'version']) {
      assert.equal(needsDirectionIsolation(kind), true, `${kind} must be isolated`)
    }
  })

  test('ordinary prose is not', () => {
    for (const kind of ['answer', 'summary', 'transcript', 'reason']) {
      assert.equal(needsDirectionIsolation(kind), false)
    }
  })
})

describe('normalization is Unicode-safe across scripts', () => {
  test('composed and decomposed forms of the same text match', () => {
    // The failure this guards: one side of a search folded with NFKD and the
    // other with NFKC, so Korean typed one way never finds Korean stored the
    // other. Both are the same string to a reader.
    const composed = '실패'
    const decomposed = composed.normalize('NFD')
    assert.notEqual(composed, decomposed, 'the two forms differ before folding')
    assert.equal(normalizeForRetrieval(composed), normalizeForRetrieval(decomposed))
  })

  test('Hangul survives the fold as syllables, not jamo', () => {
    assert.equal(normalizeForRetrieval('실패'), '실패')
  })

  test('CJK and Cyrillic are unchanged by folding', () => {
    assert.equal(normalizeForRetrieval('构建失败'), '构建失败')
    assert.equal(normalizeForRetrieval('Сборка'), 'сборка')
  })
})
