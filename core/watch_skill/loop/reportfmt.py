"""Agent-facing text rendering of loop state (shared by CLI and MCP surfaces)."""
from __future__ import annotations

from watch_skill.loop.runner import LoopState


def format_loop_state(state: LoopState) -> str:
    """Human/agent-readable summary of the latest iteration + next step."""
    latest = state.iterations[-1]
    critique = latest["critique"]
    lines = [
        f"loop_id: {state.loop_id}",
        f"status: {state.status}  (iteration {latest['n']}, "
        f"score {critique['score']}, verdict {critique['verdict']})",
        f"target: {state.target}",
        "",
        f"summary: {critique.get('summary', '')}",
    ]
    if critique["issues"]:
        lines.append("issues:")
        for issue in critique["issues"]:
            line = f"- [{issue['severity']}] t={issue['timestamp']:.1f}s {issue['description']}"
            if issue.get("suggested_fix"):
                line += f" | suggested fix: {issue['suggested_fix']}"
            lines.append(line)
    if latest.get("diff"):
        diff = latest["diff"]
        lines.append(
            f"vs previous iteration: {len(diff['fixed'])} fixed, "
            f"{len(diff['unchanged'])} unchanged, {len(diff['new'])} new, "
            f"{diff['changed_pair_count']}/{diff['aligned_pair_count']} aligned frames changed"
        )
        for issue in diff["fixed"]:
            lines.append(f"- FIXED: {issue['description']}")
    if latest.get("artifacts"):
        lines.append(f"before/after proof: {latest['artifacts']['gif']} + .mp4")
    if state.status == "running":
        lines.append(
            "\nNext step: apply the suggested fixes yourself, then call "
            f"loop_iterate(loop_id='{state.loop_id}')."
        )
    return "\n".join(lines)
