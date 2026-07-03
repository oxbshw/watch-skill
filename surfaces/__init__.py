"""Thin delivery surfaces over the core engine: MCP server, CLI, REST API.

Rule: ``core`` never imports from here; every surface is a wrapper that maps
transport concerns onto ``agentvision`` calls.
"""
