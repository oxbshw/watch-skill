"""FastAPI REST surface with auto-generated OpenAPI at /openapi.json.

The universal adapter: any agent framework that can call HTTP + read an
OpenAPI spec gets the full engine with zero custom code.
"""

from surfaces.api.app import create_app, serve

__all__ = ["create_app", "serve"]
