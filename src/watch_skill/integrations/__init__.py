"""Framework adapters: Watch Skill tools for LangChain, CrewAI, OpenAI Agents
SDK, LlamaIndex, and AutoGen.

Every adapter is deliberately THIN: a handful of framework-native tool
definitions wrapping the same three core calls (watch, ask, search) from
:mod:`watch_skill.integrations._core`. All engine logic stays in core — an
adapter never adds behavior, only a calling convention.

Each module exposes ``get_watch_tools()`` returning that framework's native
tool objects, and imports its framework lazily with an actionable error when
it is not installed. Anything not covered here can use the REST/OpenAPI
surface (``watch-skill serve --http``) — see docs/agents/frameworks.md.
"""
