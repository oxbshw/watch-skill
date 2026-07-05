"""Wire Watch Skill into your own agent, programmatically.

Most users never need this: `watch-skill setup` writes the MCP config into
every supported agent automatically. This example is for agent BUILDERS —
it drives the MCP server exactly the way an agent framework would:
connect, discover the tools, and call them.

The in-process FastMCP client used here speaks the same protocol as a
spawned stdio server, so everything below transfers 1:1 to a real
`command: uv run watch-skill serve` wiring (see the README).

Runs fully offline against whatever is already indexed.

Run:  uv run --no-sync python examples/06-agent-integration/agent_integration.py
"""
from __future__ import annotations

import asyncio
import sys

from fastmcp import Client

from watch_skill.surfaces.mcp.server import mcp

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


async def main() -> int:
    async with Client(mcp) as client:
        # 1. Discovery — what an agent sees when it connects.
        tools = await client.list_tools()
        print(f"connected: {len(tools)} tools exposed")
        for tool in tools:
            first_line = (tool.description or "").strip().splitlines()[0]
            print(f"  - {tool.name}: {first_line}")

        # 2. Call a tool exactly like an agent would.
        listing = await client.call_tool("list_videos")
        print("\n--- list_videos ---")
        print(listing.content[0].text)

        meter = await client.call_tool("stats")
        print("\n--- stats ---")
        print(meter.content[0].text)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
