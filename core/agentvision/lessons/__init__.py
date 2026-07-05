"""Self-improve loop: local lessons that make the next answer better.

Everything lives in ``<data_dir>/lessons.db`` on this machine — one store
per OS user, shared across agents, never uploaded.
"""

from agentvision.lessons.evals import export_evals, run_evals
from agentvision.lessons.inject import relevant_guidance
from agentvision.lessons.profiles import get_profile, reset_profiles, show_profiles
from agentvision.lessons.report import report_mistake
from agentvision.lessons.store import list_lessons, remove_lessons

__all__ = [
    "export_evals",
    "get_profile",
    "list_lessons",
    "relevant_guidance",
    "remove_lessons",
    "report_mistake",
    "reset_profiles",
    "run_evals",
    "show_profiles",
]
