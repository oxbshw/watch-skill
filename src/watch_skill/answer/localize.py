"""Emit the engine's own words in the language of the QUESTION.

The honest-floor refusal, the evidence label, and the answer-language
directive we hand the vision model are all localized off a lightweight
detector, so a Spanish question about a Japanese video gets a Spanish
refusal and a Spanish model answer. English is the untouched default.

RTL (Arabic/Hebrew/Persian/Urdu): timestamps and citations are wrapped in
Unicode isolates (LRI…PDI) so the bidirectional algorithm can't reorder a
`[12:34]` or reverse its digits — without mangling logical order for the
LLM that consumes the text.
"""
from __future__ import annotations

LRI, PDI = "⁦", "⁩"  # left-to-right isolate / pop directional isolate

_RTL_LANGS = frozenset({"ar", "he", "fa", "ur"})

# Endonym + English name for the model answer-language directive.
_LANG_NAMES = {
    "en": "English",
    "ar": "Arabic (العربية)",
    "he": "Hebrew (עברית)",
    "es": "Spanish (español)",
    "fr": "French (français)",
    "de": "German (Deutsch)",
    "pt": "Portuguese (português)",
    "it": "Italian (italiano)",
    "ja": "Japanese (日本語)",
    "zh": "Chinese (中文)",
    "ko": "Korean (한국어)",
    "ru": "Russian (русский)",
    "hi": "Hindi (हिन्दी)",
    "el": "Greek (Ελληνικά)",
    "th": "Thai (ไทย)",
}

# (lang, [(lo, hi) ranges]) — kana before han so Japanese wins over Chinese.
_SCRIPTS: tuple[tuple[str, tuple[tuple[int, int], ...]], ...] = (
    ("ja", ((0x3040, 0x30FF), (0x31F0, 0x31FF))),
    ("ko", ((0xAC00, 0xD7AF), (0x1100, 0x11FF))),
    ("zh", ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))),
    ("he", ((0x0590, 0x05FF),)),
    ("ar", ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF))),
    ("ru", ((0x0400, 0x04FF),)),
    ("hi", ((0x0900, 0x097F),)),
    ("el", ((0x0370, 0x03FF),)),
    ("th", ((0x0E00, 0x0E7F),)),
)

# Function words for the Latin-script languages (script cannot tell them
# apart). Words shared between languages are deliberately listed in *every*
# language that uses them: the scorer weights a token by how many languages
# claim it, so declaring a shared word only once would silently hand it to
# whichever language happened to list it.
#
# Portuguese carries accented and unaccented spellings, because people type
# "nao" and "voce" constantly and a detector that only knows "não" fails the
# users most likely to need it.
_LATIN_STOP: dict[str, set[str]] = {
    "es": {"el", "la", "los", "las", "qué", "cómo", "cuándo", "dónde", "por", "para",
           "una", "cuando", "muestra", "aparece", "vídeo", "video", "está", "esta",
           "pantalla", "es", "no", "son", "cuál", "sobre", "tiene", "ella", "eso"},
    "fr": {"le", "les", "que", "qui", "quand", "où", "comment", "pour", "une", "est",
           "dans", "quel", "quelle", "apparaît", "vidéo", "écran", "montre", "sur",
           "pas", "elle", "cela"},
    "de": {"der", "die", "das", "und", "wann", "wie", "wo", "was", "ein", "eine",
           "zeigt", "warum", "bildschirm", "erscheint", "video"},
    "pt": {"os", "as", "que", "quando", "onde", "como", "para", "uma", "aparece",
           "vídeo", "video", "mostra", "tela", "está", "esta", "é", "não", "nao",
           "são", "sao", "qual", "quais", "do", "da", "dos", "das", "você", "voce",
           "ele", "ela", "isso", "sobre", "tem", "na", "no", "com", "por"},
    "it": {"il", "le", "che", "di", "quando", "dove", "come", "per", "una", "mostra",
           "video", "appare", "schermo", "non", "sono", "quale", "questo", "sul"},
    # English is listed as fully as the others on purpose. It used to carry a
    # handful of words, so an English question with no listed token scored zero
    # everywhere and any single foreign-looking word won outright.
    "en": {"the", "what", "when", "where", "how", "why", "is", "does", "do", "show",
           "video", "at", "of", "screen", "appear", "they", "agree", "are", "and",
           "to", "in", "on", "it", "this", "that", "with", "about", "who", "which",
           "was", "did", "no", "not", "a", "an"},
}

# How much stronger the winner must be before we call it resolved. A margin
# rather than a threshold: "some evidence for Portuguese" means nothing if
# there is equal evidence for Spanish.
_MIN_SCORE = 0.75
_MIN_MARGIN = 0.35


class LanguageGuess:
    """A detection result that can admit it does not know.

    The previous detector always returned a language, so "no idea" and
    "definitely Spanish" were the same type and the caller could not tell them
    apart. Weak evidence now says so, and callers fall back deliberately
    instead of acting on a coin toss.
    """

    __slots__ = ("lang", "confidence", "resolved", "candidates")

    def __init__(self, lang: str, confidence: float, resolved: bool,
                 candidates: tuple[str, ...] = ()) -> None:
        self.lang = lang
        self.confidence = confidence
        self.resolved = resolved
        self.candidates = candidates

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (f"LanguageGuess({self.lang!r}, confidence={self.confidence:.2f}, "
                f"resolved={self.resolved}, candidates={self.candidates})")

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):  # keeps `detect(...) == "pt"` readable
            return self.lang == other
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.lang)


def _token_weights() -> dict[str, float]:
    """How much each token is worth: 1 / (languages that claim it).

    A word only Portuguese uses is worth a full point; one shared by
    Portuguese, Spanish and Italian is worth a third to each. This is what
    replaces PR #16's tie-break — there is nothing left to break a tie *with*
    when distinctiveness is already priced in.
    """
    claims: dict[str, int] = {}
    for words in _LATIN_STOP.values():
        for word in words:
            claims[word] = claims.get(word, 0) + 1
    return {word: 1.0 / count for word, count in claims.items()}


_WEIGHTS = _token_weights()


def detect_language(text: str) -> LanguageGuess:
    """Detect the language of ``text``, or say plainly that it could not.

    Script first — an Arabic character settles the question. For Latin script
    it is a weighted stopword vote where a token's weight falls off with the
    number of languages that use it.

    Ordering never decides anything: ties are broken by sorted name only after
    being declared unresolved, so the result does not depend on how the
    dictionaries above happen to be written.
    """
    counts: dict[str, int] = {}
    for ch in text:
        cp = ord(ch)
        for lang, ranges in _SCRIPTS:
            if any(lo <= cp <= hi for lo, hi in ranges):
                counts[lang] = counts.get(lang, 0) + 1
                break
    if counts:
        top = max(counts.values())
        winners = sorted(lang for lang, n in counts.items() if n == top)
        return LanguageGuess(winners[0], 1.0, True, tuple(winners))

    tokens = {t.strip(".,!?¿¡:;\"'()«»…").lower() for t in text.split()}
    tokens.discard("")
    scores = {
        lang: round(sum(_WEIGHTS.get(token, 0.0) for token in tokens & words), 6)
        for lang, words in _LATIN_STOP.items()
    }
    best_score = max(scores.values(), default=0.0)
    if best_score < _MIN_SCORE:
        return LanguageGuess("en", 0.0, False, ())

    leaders = sorted(lang for lang, score in scores.items() if score == best_score)
    runner_up = max(
        (score for lang, score in scores.items() if lang not in leaders),
        default=0.0,
    )
    margin = best_score - runner_up
    if len(leaders) > 1 or margin < _MIN_MARGIN:
        ambiguous = tuple(sorted(
            lang for lang, score in scores.items()
            if best_score - score < _MIN_MARGIN
        ))
        return LanguageGuess("en", round(margin / best_score, 3), False, ambiguous)

    return LanguageGuess(
        leaders[0], round(min(1.0, margin / best_score), 3), True, (leaders[0],)
    )


def detect_lang(text: str) -> str:
    """Best-effort language code, English when undecided.

    Kept as the simple string API every existing caller uses. Reach for
    :func:`detect_language` when the difference between "English" and "no
    idea, defaulting to English" actually matters.
    """
    return detect_language(text).lang


def is_rtl(lang: str) -> bool:
    return lang in _RTL_LANGS


def isolate(text: str) -> str:
    """Wrap in an LTR isolate so RTL context can't reorder it (e.g. a timestamp)."""
    return f"{LRI}{text}{PDI}"


def answer_language_directive(
    lang: str | LanguageGuess, fallback: str | None = None
) -> str:
    """A one-line instruction telling the model which language to write in.

    When the guess is **unresolved**, this does not name a language. Naming
    English would be as wrong as naming the coin-toss winner: an Arabic
    question whose script we somehow failed to classify would be answered in
    English, which is the one outcome the whole module exists to prevent.

    Instead the model is told to mirror the user's own wording. It can see the
    question; it does not need us to guess at what we could not classify.

    ``fallback`` is honoured only when a caller deliberately configured one —
    a default nobody chose is not a preference.
    """
    if isinstance(lang, LanguageGuess):
        if not lang.resolved:
            if fallback:
                name = _LANG_NAMES.get(fallback, fallback)
                return (f"Write all human-readable text in {name}, the "
                        "configured default language.")
            return (
                "Write all human-readable text in the same language the user "
                "wrote their request in. Do not translate their words."
            )
        code = lang.lang
    else:
        code = lang or fallback or "en"
    name = _LANG_NAMES.get(code, "English")
    return f"Write all human-readable text in {name}, the language of the request."


# The engine's fixed strings, per language. English is the canonical wording
# the trust-contract tests assert against; others mirror it.
MESSAGES: dict[str, dict[str, str]] = {
    "en": {
        "floor_headline": "The video does not clearly show an answer to: {q}.",
        "floor_noguess": "No guess is being made. The closest indexed moments are:",
        "floor_nothing": "- (nothing relevant found in transcript, OCR, or scene descriptions)",
        "floor_hint": "If the answer should be visible, try get_moment on a timestamp above, "
                      "or re-watch with a focused start/end window.",
        "evidence_label": "Evidence:",
    },
    "ar": {
        "floor_headline": "الفيديو لا يُظهر بوضوح إجابة عن: {q}.",
        "floor_noguess": "لن يتم التخمين. أقرب اللحظات المفهرسة هي:",
        "floor_nothing": "- (لم يُعثر على شيء ذي صلة في النص أو التعرّف الضوئي على الحروف أو أوصاف المشاهد)",
        "floor_hint": "إذا كان يُفترض أن تكون الإجابة مرئية، جرّب get_moment على أحد الطوابع الزمنية "
                      "أعلاه، أو أعد المشاهدة ضمن نطاق بداية/نهاية محدّد.",
        "evidence_label": "الأدلة:",
    },
    "he": {
        "floor_headline": "הסרטון אינו מציג באופן ברור תשובה ל: {q}.",
        "floor_noguess": "לא נעשית שום השערה. הרגעים המאונדקסים הקרובים ביותר הם:",
        "floor_nothing": "- (לא נמצא דבר רלוונטי בתמלול, ב-OCR או בתיאורי הסצנות)",
        "floor_hint": "אם התשובה אמורה להיות גלויה, נסה get_moment על אחת מחותמות הזמן שלמעלה, "
                      "או צפה שוב עם טווח התחלה/סיום ממוקד.",
        "evidence_label": "ראיות:",
    },
    "es": {
        "floor_headline": "El vídeo no muestra claramente una respuesta a: {q}.",
        "floor_noguess": "No se hace ninguna conjetura. Los momentos indexados más cercanos son:",
        "floor_nothing": "- (no se encontró nada relevante en la transcripción, el OCR ni las "
                         "descripciones de escenas)",
        "floor_hint": "Si la respuesta debería ser visible, prueba get_moment en una de las marcas "
                      "de tiempo anteriores, o vuelve a analizar con un rango de inicio/fin concreto.",
        "evidence_label": "Evidencia:",
    },
    "fr": {
        "floor_headline": "La vidéo ne montre pas clairement de réponse à : {q}.",
        "floor_noguess": "Aucune supposition n'est faite. Les moments indexés les plus proches sont :",
        "floor_nothing": "- (rien de pertinent trouvé dans la transcription, l'OCR ou les descriptions "
                         "de scènes)",
        "floor_hint": "Si la réponse devrait être visible, essayez get_moment sur l'un des horodatages "
                      "ci-dessus, ou relancez l'analyse avec une plage de début/fin ciblée.",
        "evidence_label": "Preuves :",
    },
    "de": {
        "floor_headline": "Das Video zeigt keine eindeutige Antwort auf: {q}.",
        "floor_noguess": "Es wird nicht geraten. Die nächstgelegenen indizierten Momente sind:",
        "floor_nothing": "- (nichts Relevantes in Transkript, OCR oder Szenenbeschreibungen gefunden)",
        "floor_hint": "Wenn die Antwort sichtbar sein sollte, versuche get_moment an einem der "
                      "Zeitstempel oben oder analysiere erneut mit einem gezielten Start/End-Bereich.",
        "evidence_label": "Belege:",
    },
    "pt": {
        "floor_headline": "O vídeo não mostra claramente uma resposta para: {q}.",
        "floor_noguess": "Nenhuma suposição está sendo feita. Os momentos indexados mais próximos são:",
        "floor_nothing": "- (nada relevante encontrado na transcrição, no OCR ou nas descrições de cena)",
        "floor_hint": "Se a resposta deveria estar visível, tente get_moment em um dos carimbos de "
                      "tempo acima, ou refaça a análise com um intervalo de início/fim específico.",
        "evidence_label": "Evidências:",
    },
    "it": {
        "floor_headline": "Il video non mostra chiaramente una risposta a: {q}.",
        "floor_noguess": "Non viene fatta alcuna supposizione. I momenti indicizzati più vicini sono:",
        "floor_nothing": "- (nessun elemento pertinente trovato nella trascrizione, nell'OCR o nelle "
                         "descrizioni delle scene)",
        "floor_hint": "Se la risposta dovrebbe essere visibile, prova get_moment su uno dei timestamp "
                      "sopra, oppure rianalizza con un intervallo di inizio/fine mirato.",
        "evidence_label": "Prove:",
    },
    "ja": {
        "floor_headline": "この動画には「{q}」に対する明確な答えは映っていません。",
        "floor_noguess": "推測は行いません。最も近いインデックス済みの箇所は次のとおりです:",
        "floor_nothing": "-（文字起こし・OCR・シーン説明のいずれにも関連するものは見つかりませんでした）",
        "floor_hint": "答えが映っているはずなら、上のタイムスタンプで get_moment を試すか、"
                      "開始／終了範囲を絞って見直してください。",
        "evidence_label": "根拠:",
    },
    "zh": {
        "floor_headline": "视频没有清楚显示以下问题的答案：{q}。",
        "floor_noguess": "不做任何猜测。最接近的已索引时刻为：",
        "floor_nothing": "-（在转写、OCR 或场景描述中未找到相关内容）",
        "floor_hint": "如果答案本应可见，请对上面的某个时间戳使用 get_moment，"
                      "或用更聚焦的开始/结束区间重新观看。",
        "evidence_label": "证据：",
    },
    "ko": {
        "floor_headline": "이 영상에는 다음 질문에 대한 명확한 답이 나타나지 않습니다: {q}.",
        "floor_noguess": "추측하지 않습니다. 가장 가까운 색인된 순간은 다음과 같습니다:",
        "floor_nothing": "- (자막, OCR, 장면 설명에서 관련 내용을 찾지 못했습니다)",
        "floor_hint": "답이 보여야 한다면 위의 타임스탬프에서 get_moment을 시도하거나 "
                      "시작/종료 구간을 좁혀 다시 시청하세요.",
        "evidence_label": "근거:",
    },
    "ru": {
        "floor_headline": "В видео нет чёткого ответа на: {q}.",
        "floor_noguess": "Догадки не делаются. Ближайшие проиндексированные моменты:",
        "floor_nothing": "- (ничего релевантного не найдено в транскрипте, OCR или описаниях сцен)",
        "floor_hint": "Если ответ должен быть виден, попробуйте get_moment на одной из меток времени "
                      "выше или пересмотрите с заданным диапазоном начала/конца.",
        "evidence_label": "Доказательства:",
    },
    "hi": {
        "floor_headline": "वीडियो में इसका उत्तर स्पष्ट रूप से नहीं दिखता: {q}.",
        "floor_noguess": "कोई अनुमान नहीं लगाया जा रहा। निकटतम अनुक्रमित क्षण ये हैं:",
        "floor_nothing": "- (ट्रांसक्रिप्ट, OCR या दृश्य विवरण में कुछ भी प्रासंगिक नहीं मिला)",
        "floor_hint": "यदि उत्तर दिखना चाहिए, तो ऊपर दिए किसी टाइमस्टैम्प पर get_moment आज़माएँ, "
                      "या केंद्रित आरंभ/अंत सीमा के साथ फिर से देखें।",
        "evidence_label": "प्रमाण:",
    },
}


def messages(lang: str) -> dict[str, str]:
    """The message table for ``lang``, falling back to English."""
    return MESSAGES.get(lang, MESSAGES["en"])
