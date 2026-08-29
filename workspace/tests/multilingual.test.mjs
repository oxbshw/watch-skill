/**
 * Evidence in six writing systems, and back again unchanged.
 *
 * The rule the whole suite is about: **the original text is the evidence.**
 * Anything else — a normalized index form, a translation, a display string —
 * is derived, and a citation resolves to the original or it resolves to
 * nothing.
 *
 * That rule is easy to state and easy to lose, always in the same way: some
 * layer normalizes for a good reason, forgets to keep the original, and from
 * then on the product quotes a sentence nobody said. So every sample here goes
 * through a full round trip — record, index, search, cite, render — and the
 * assertion at the end is byte equality with what went in.
 *
 * The samples are real sentences in real scripts because every failure this
 * catches is specific to real writing: Arabic diacritics stripped by a fold, a
 * Russian ё flattened to е, a Chinese string measured as twice its length, a
 * Devanagari cluster split at a combining mark, and a Latin path inside Arabic
 * prose reordered by the bidi algorithm into something plausible and wrong.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  describeText,
  detectDirection,
  detectScripts,
  displayText,
  needsDirectionIsolation,
  normalizeForRetrieval,
  withTranslation,
} from '@watchskill/dsh-contracts'
import { characterErrorRate } from '@watchskill/dsh-technology'
import { Isolated } from '@watchskill/dsh-workspace/components'

import {
  ARABIC_TRANSLATION,
  MIXED_ISOLATED_SPANS,
  SAMPLES,
  evidenceTextFor,
} from './fixtures/multilingual.mjs'

/** Look one sample up by id. */
function sample(id) {
  const found = SAMPLES.find(entry => entry.id === id)
  assert.notEqual(found, undefined, `no sample ${id}`)
  return found
}

// ── the round trip ──────────────────────────────────────────────────────────

describe('every script survives the round trip byte for byte', () => {
  for (const entry of SAMPLES) {
    test(`${entry.label}: the original is what comes back`, () => {
      const evidence = evidenceTextFor(entry)

      // Index it. Normalization is for retrieval and is stored beside the
      // original, never in place of it.
      const indexed = { ...evidence, normalizedText: normalizeForRetrieval(entry.text) }
      assert.equal(indexed.originalText, entry.text, 'indexing changed the evidence')

      // Cite it. What a citation resolves to is the original, whatever the
      // reader's preference, when no translation exists for that preference.
      const displayed = displayText(indexed, 'en')
      if (entry.id === 'latin') {
        assert.equal(displayed.text, entry.text)
      } else {
        assert.equal(displayed.text, entry.text,
          'a citation resolved to something other than the original')
        assert.equal(displayed.isOriginal, true)
      }

      // Render it. The markup contains the original, unescaped beyond HTML.
      const markup = renderToStaticMarkup(createElement(Isolated, { kind: 'prose' }, entry.text))
      assert.ok(markup.includes(entry.needle),
        `the rendered text lost ${entry.needle}`)
    })
  }

  test('normalization is stored beside the original, never over it', () => {
    for (const entry of SAMPLES) {
      const indexed = { ...evidenceTextFor(entry), normalizedText: normalizeForRetrieval(entry.text) }
      assert.equal(indexed.originalText, entry.text)
      assert.notEqual(indexed.normalizedText, null)
    }
  })

  test('a fold that changes a letter is visible as a difference', () => {
    // Russian ё and е are different letters. The normalized form may fold
    // them — that is what it is for — and the original must not.
    const russian = sample('cyrillic')
    assert.ok(russian.text.includes('ё'))
    const normalized = normalizeForRetrieval(russian.text)
    assert.notEqual(normalized, russian.text, 'nothing was normalized at all')
    assert.ok(evidenceTextFor(russian).originalText.includes('ё'),
      'the original lost a letter to normalization')
  })

  test('Arabic diacritics survive on the original', () => {
    const arabic = sample('arabic')
    // The vocalisation marks are in the U+064B–U+0652 range.
    const marks = /[ً-ْ]/
    assert.ok(marks.test(arabic.text), 'the fixture is not vocalised')
    assert.ok(marks.test(evidenceTextFor(arabic).originalText),
      'the evidence lost its diacritics')
  })

  test('a Devanagari cluster is not split by the round trip', () => {
    const hindi = sample('devanagari')
    const evidence = evidenceTextFor(hindi)
    assert.ok(evidence.originalText.includes('स्वास्थ्य'),
      'a conjunct cluster was broken')
  })
})

// ── detection ───────────────────────────────────────────────────────────────

describe('scripts and direction are reported, not guessed', () => {
  for (const entry of SAMPLES) {
    test(`${entry.label}: the scripts present are detected`, () => {
      const detected = detectScripts(entry.text)
      for (const script of entry.scripts) {
        assert.ok(detected.includes(script),
          `${script} not detected in ${entry.label}; got ${detected.join(', ')}`)
      }
    })
  }

  test('direction follows the text', () => {
    assert.equal(detectDirection(sample('latin').text), 'ltr')
    assert.equal(detectDirection(sample('arabic').text), 'rtl')
    assert.equal(detectDirection(sample('han').text), 'ltr')
  })

  test('a mixed line is reported as mixed rather than as one of its halves', () => {
    const mixed = sample('mixed')
    const detected = detectScripts(mixed.text)
    assert.ok(detected.includes('Arabic'))
    assert.ok(detected.includes('Latin'))
    assert.equal(detectDirection(mixed.text), 'mixed')
  })

  test('the two script vocabularies differ on purpose, and the difference is stated', async () => {
    // The evidence contract says `Han`. The OCR qualification matrix says
    // `Han_Simplified` and `Han_Traditional`. That is not drift: range-based
    // detection genuinely cannot tell simplified from traditional, so the
    // evidence side reports what it can see, while the qualification matrix
    // measures engines against a distinction a person supplies with the
    // fixture. Asserted here so the difference stays deliberate.
    const technology = await import('@watchskill/dsh-technology')
    assert.ok(technology.SCRIPTS.includes('Han_Simplified'))
    assert.ok(technology.SCRIPTS.includes('Han_Traditional'))
    assert.deepEqual(detectScripts('部署成功'), ['Han'],
      'the evidence detector claimed a distinction it cannot make')
  })

  test('a language tag is never invented from a script', () => {
    // Arabic script is used by several languages. Detection reports the
    // script; the tag stays empty unless something actually knows.
    const described = describeText(sample('arabic').text, 'watch-core', '1')
    assert.deepEqual([...described.languageTags], [],
      'a language was guessed from a script')
    assert.ok(described.scripts.includes('Arabic'))
    assert.equal(described.languageConfidence, null)
  })
})

// ── translation is derived ──────────────────────────────────────────────────

describe('a translation is a view, never the evidence', () => {
  const arabic = sample('arabic')
  const translated = withTranslation(evidenceTextFor(arabic), ARABIC_TRANSLATION)

  test('the original is untouched by adding one', () => {
    assert.equal(translated.originalText, arabic.text)
    assert.equal(translated.translations.length, 1)
  })

  test('a reader who asked for English gets it, and is told it is not the original', () => {
    const shown = displayText(translated, 'en')
    assert.equal(shown.text, ARABIC_TRANSLATION.text)
    assert.equal(shown.isOriginal, false)
  })

  test('a reader who asked for nothing gets the original', () => {
    const shown = displayText(translated, null)
    assert.equal(shown.text, arabic.text)
    assert.equal(shown.isOriginal, true)
  })

  test('a language with no translation falls back to the original, not to English', () => {
    const shown = displayText(translated, 'fr')
    assert.equal(shown.text, arabic.text)
    assert.equal(shown.isOriginal, true)
  })

  test('the translation carries its own direction', () => {
    const shown = displayText(translated, 'en')
    assert.equal(shown.direction, 'ltr',
      'English output was rendered with the Arabic source direction')
  })

  test('a translation has no evidence id of its own', () => {
    for (const translation of translated.translations) {
      assert.equal('evidenceId' in translation, false)
      assert.equal('freshness' in translation, false)
    }
  })

  test('a translation with no calibrated score reports none', () => {
    assert.equal(ARABIC_TRANSLATION.confidence, null)
  })
})

// ── bidi isolation ──────────────────────────────────────────────────────────

describe('a Latin fragment inside Arabic prose does not reorder it', () => {
  test('every span the contract isolates is isolated in the markup', () => {
    for (const span of MIXED_ISOLATED_SPANS) {
      assert.equal(needsDirectionIsolation(span.kind), true, `${span.kind} is not isolated`)
      const markup = renderToStaticMarkup(createElement(Isolated, { kind: span.kind }, span.text))
      assert.match(markup, /dir="ltr"/)
      assert.match(markup, /data-watch-ltr/)
      assert.ok(markup.includes(span.text))
    }
  })

  test('the surrounding prose keeps its own direction', () => {
    const markup = renderToStaticMarkup(
      createElement(Isolated, { kind: 'prose' }, sample('mixed').text),
    )
    assert.match(markup, /dir="auto"/)
    assert.equal(/dir="ltr"/.test(markup), false)
  })

  test('the path is present verbatim, with its segments in order', () => {
    const markup = renderToStaticMarkup(
      createElement(Isolated, { kind: 'path' }, '/api/v2/deploy'),
    )
    assert.ok(markup.includes('/api/v2/deploy'))
    assert.equal(markup.includes('deploy/v2/api/'), false)
  })
})

// ── measurement ─────────────────────────────────────────────────────────────

describe('non-Latin text is measured as itself', () => {
  test('a Chinese string is not scored as twice its length', () => {
    const han = sample('han').text
    assert.equal(characterErrorRate(han, han), 0)
    // One character wrong out of [...han].length, not out of han.length.
    const codePoints = [...han].length
    const wrong = `${[...han].slice(0, -1).join('')}X`
    assert.ok(Math.abs(characterErrorRate(han, wrong) - 1 / codePoints) < 1e-9,
      'the error rate was computed over UTF-16 units rather than code points')
  })

  test('dropping Arabic diacritics is scored as an error, not as a match', () => {
    const vocalised = sample('arabic').text
    const stripped = vocalised.replace(/[ً-ْ]/g, '')
    assert.ok(characterErrorRate(vocalised, stripped) > 0,
      'a fold that changed the text scored as perfect')
  })

  test('an identical string scores zero in every script', () => {
    for (const entry of SAMPLES) {
      assert.equal(characterErrorRate(entry.text, entry.text), 0, `${entry.label} did not match itself`)
    }
  })
})

// ── search ──────────────────────────────────────────────────────────────────

describe('a query typed differently still finds the original', () => {
  test('a normalized query matches normalized text, and cites the original', () => {
    const russian = sample('cyrillic')
    const indexed = normalizeForRetrieval(russian.text)
    // Somebody types it without the diaeresis.
    const query = normalizeForRetrieval('Развертывание')
    assert.ok(indexed.includes(query),
      'a query typed without the diacritic did not match the folded index')
    // And what comes back is the original, with the diacritic.
    assert.ok(evidenceTextFor(russian).originalText.includes('Развёртывание'))
  })

  test('folding is for the index and never reaches a citation', () => {
    for (const entry of SAMPLES) {
      const evidence = { ...evidenceTextFor(entry), normalizedText: normalizeForRetrieval(entry.text) }
      const cited = displayText(evidence, null)
      assert.equal(cited.text, entry.text)
      assert.notEqual(cited.text, evidence.normalizedText,
        `${entry.label} cited its normalized form`)
    }
  })
})
