# agent-runtime — fat multi-runtime image
#
# Runtimes included:
#   Node 20       agent-runtime TypeScript
#   Python 3.12   Airflow 3.1.3 compatibility
#   Go 1.25       Go services in operator stack
#
# Build context: workflow/ root (one level up from agent-runtime/)
#   docker build -f agent-runtime/Dockerfile .
#
# Build args:
#   GO_VERSION   default: 1.25.0  (override if 1.25 is not yet released: --build-arg GO_VERSION=1.24.2)
#   TARGETARCH   set automatically by docker buildx (amd64 | arm64)

# ── Stage 1: TypeScript builder ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# Install dependencies first for better layer caching.
COPY agent-runtime/package*.json ./
RUN npm ci

# Copy source and compile.
COPY agent-runtime/src/ ./src/
COPY agent-runtime/tsconfig.json ./
RUN npm run build

# Prune dev dependencies — only production modules go into the runtime image.
RUN npm prune --production

# ── Stage 2: Fat runtime image ────────────────────────────────────────────────
# python:3.12-slim-bookworm provides Python 3.12 out of the box.
# Node 20 and Go are layered on top.
FROM python:3.12-slim-bookworm AS runtime

ARG GO_VERSION=1.25.0
ARG TARGETARCH=amd64

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        git \
        openssh-client \
        tini \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── Node 20 via NodeSource ────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Go ────────────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
        -o /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:$PATH"
ENV GOPATH="/go"
ENV PATH="$GOPATH/bin:$PATH"

# ── Package managers ─────────────────────────────────────────────────────────
# yarn is needed for repos that ship a yarn.lock (most implementation repos).
RUN npm install -g yarn

# ── Claude CLI ───────────────────────────────────────────────────────────────
# Required by run-task.ts — spawned as a subprocess for each task activation.
# GITHUB_TOKEN must be injected at runtime (see DOCKER.md).
RUN npm install -g @anthropic-ai/claude-code

# ── Workspace layout ──────────────────────────────────────────────────────────
# Mirror the local repo structure so relative schema paths resolve correctly.
# validate-agent-yaml.ts resolves: dist/config/../../.. → /workflow/schemas/
WORKDIR /workflow

# Schemas from the workflow root (needed by the AJV validators at runtime).
COPY schemas/ ./schemas/

# Agent-runtime app.
WORKDIR /workflow/agent-runtime

COPY --from=builder /build/dist ./dist/
COPY --from=builder /build/node_modules ./node_modules/
COPY --from=builder /build/package.json ./package.json

COPY agent-runtime/scripts/ ./scripts/
RUN chmod +x ./scripts/run-once.sh

# ── Non-root user ─────────────────────────────────────────────────────────────
# Claude Code blocks --dangerously-skip-permissions when running as root.
# Run as a dedicated agent user so the flag is accepted.
#
# Named volume initialisation: Docker copies image directory contents (with
# their permissions) into a named volume on first use. Pre-creating /agent/*
# as agent-owned here ensures fresh volumes start writable by the agent user.
# If volumes already exist as root-owned, recreate them:
#   docker compose down -v && docker compose up --build
RUN useradd -m -u 1001 -s /bin/bash agent \
    && mkdir -p /agent/data /agent/ssh /agent/workflow /home/agent/.ssh \
    && chmod 700 /home/agent/.ssh \
    && chown -R agent:agent /agent /workflow /home/agent

# Relocate GOPATH so the module cache is writable by the agent user.
ENV GOPATH="/home/agent/go"
ENV PATH="/home/agent/go/bin:$PATH"

USER agent

# ── Container contract ────────────────────────────────────────────────────────
# Required env vars — see DOCKER.md for full documentation.
ENV AGENT_YAML_PATH="/agent/agent.yaml"
ENV WORKFLOW_LOCAL_PATH="/agent/workflow"
ENV WORKSPACES_ROOT="/agent/data"

# Volume mounts (documented in DOCKER.md):
#   /agent/agent.yaml   — agent configuration (read-only)
#   /agent/data/        — workspace clones (read-write)
#   /agent/ssh/         — SSH key directory (read-only)

ENTRYPOINT ["/usr/bin/tini", "--", "/workflow/agent-runtime/scripts/run-once.sh"]
