"""Library layer: distilled notes per video, synthesis across all of them.

The index remembers everything one video showed; the library makes the
COLLECTION answerable. After each watch, `distill_notes` reduces that one
video to entities, claims, and chapters — every item carrying
(video_id, timestamp) provenance. `library_synthesize` answers questions
no single video answers, from notes first, drilling into real indexed
evidence, with per-video citations and the same honest floor the
single-video engine has.
"""
from watch_skill.library.notes import distill_notes
from watch_skill.library.synthesize import (
    LibraryAnswer,
    library_overview,
    library_synthesize,
)

__all__ = [
    "LibraryAnswer",
    "distill_notes",
    "library_overview",
    "library_synthesize",
]
