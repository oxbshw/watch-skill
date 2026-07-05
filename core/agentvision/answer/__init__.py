"""Self-healing answers: confidence-scored, escalating, honest-by-default.

``answer_question`` wraps retrieval with a confidence score derived from
real signals, a cheap-first escalation ladder, an optional model verify
pass, a semantic answer cache, and an honest floor that refuses to guess.
"""

from agentvision.answer.engine import answer_question
from agentvision.answer.types import Answer, Evidence

__all__ = ["Answer", "Evidence", "answer_question"]
