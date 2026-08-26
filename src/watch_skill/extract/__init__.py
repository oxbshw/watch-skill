"""Structured extraction over the persistent index: chapters, notes, bug
reports, hook analysis. Everything reads what watch+index already stored — no
re-processing, deterministic by default (model-free), so results are
reproducible and testable.
"""

from watch_skill.extract.bug_report import extract_bug_report
from watch_skill.extract.chapters import extract_chapters
from watch_skill.extract.hook import analyze_hook
from watch_skill.extract.notes import build_notes, render_notes

__all__ = [
    "analyze_hook",
    "build_notes",
    "extract_bug_report",
    "extract_chapters",
    "render_notes",
]
