# Watch Skill in a container: ffmpeg, yt-dlp, and the full dependency tier
# already resolved. For anyone who wants the engine without putting ~600 MB
# of wheels on their own machine.
#
#   docker run --rm -v watch-skill-data:/data ghcr.io/oxbshw/watch-skill --help
#   docker run --rm -i -v watch-skill-data:/data ghcr.io/oxbshw/watch-skill serve
#
# The volume matters: the persistent index is the product. Without it every
# run re-downloads and re-transcribes.

FROM python:3.12-slim-bookworm

# ffmpeg is the one dependency the doctor cannot bootstrap inside a slim
# image without a package manager; install it here so first run is clean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies resolve from the lockfile in their own layer, so edits to the
# source do not invalidate a ~600 MB install.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --extra all --frozen --no-install-project

COPY src/ ./src/
RUN uv sync --extra all --frozen

# The Playwright package is installed; its browser is not, because Chromium
# plus system libraries roughly doubles the image. Everything except THE LOOP
# works as-is, and `doctor` says so. To capture browser sessions in the
# container, extend this image:
#     FROM ghcr.io/oxbshw/watch-skill
#     RUN playwright install --with-deps chromium

ENV PATH="/app/.venv/bin:$PATH" \
    WATCHSKILL_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

# Anything worth keeping lives here: index, frames, transcripts, lessons.
VOLUME ["/data"]
RUN mkdir -p /data

# stdio MCP needs a clean stdout, so the entrypoint is the CLI itself and
# the default command is the thing most people want.
ENTRYPOINT ["watch-skill"]
CMD ["--help"]
