#!/usr/bin/env bash
# bootstrap-agent-host.sh — one-command agent-runtime host setup
#
# Sets up Docker, pulls the agent-runtime image, writes a starter agent.yaml,
# provisions credentials, optionally installs a systemd timer, and dry-runs.
#
# Supported platforms: Ubuntu/Debian, Fedora/RHEL/Rocky, macOS (Homebrew)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tiendv89/agent-workflow/main/agent-runtime/scripts/bootstrap-agent-host.sh | bash
#   # or run locally:
#   bash agent-runtime/scripts/bootstrap-agent-host.sh [--non-interactive]
#
# Options:
#   --non-interactive   Skip all prompts (requires env vars set in advance — see README)
#   --image IMAGE       Use a specific agent-runtime image (default: ghcr.io/tiendv89/agent-runtime:latest)
#   --dry-run-only      Bootstrap, validate, then exit without installing a persistent schedule

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

DEFAULT_IMAGE="ghcr.io/tiendv89/agent-runtime:latest"
AGENT_CONFIG_DIR="/etc/agent-runtime"
SYSTEMD_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Colour helpers (disabled when not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

log()  { echo -e "${CYAN}[bootstrap]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────────

NON_INTERACTIVE=false
AGENT_IMAGE="${DEFAULT_IMAGE}"
DRY_RUN_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --image)           AGENT_IMAGE="$2"; shift ;;
    --dry-run-only)    DRY_RUN_ONLY=true ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

# ── OS detection ───────────────────────────────────────────────────────────────

OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [ -f /etc/os-release ]; then
  . /etc/os-release
  case "$ID" in
    ubuntu|debian|raspbian) OS="debian" ;;
    fedora|rhel|centos|rocky|almalinux) OS="fedora" ;;
  esac
fi
log "Detected OS: ${OS}"

# ── Docker installation ────────────────────────────────────────────────────────

install_docker_debian() {
  log "Installing Docker (Debian/Ubuntu)..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
}

install_docker_fedora() {
  log "Installing Docker (Fedora/RHEL)..."
  dnf -y install dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
}

install_docker_macos() {
  if ! command -v brew &>/dev/null; then
    die "Homebrew not found. Install from https://brew.sh/ then re-run."
  fi
  log "Installing Docker Desktop via Homebrew..."
  brew install --cask docker
  open -a Docker
  log "Waiting for Docker to start (up to 60 s)..."
  for _ in $(seq 1 60); do
    docker info &>/dev/null && break || sleep 1
  done
}

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  ok "Docker is already running"
else
  log "Docker not found or not running — installing..."
  if [ "$OS" = "debian" ]; then
    [ "$(id -u)" -eq 0 ] || die "Root required to install Docker on Debian/Ubuntu. Re-run with sudo."
    install_docker_debian
  elif [ "$OS" = "fedora" ]; then
    [ "$(id -u)" -eq 0 ] || die "Root required to install Docker on Fedora/RHEL. Re-run with sudo."
    install_docker_fedora
  elif [ "$OS" = "macos" ]; then
    install_docker_macos
  else
    die "Unsupported OS for automatic Docker install. Install Docker manually and re-run."
  fi
  docker info &>/dev/null || die "Docker installed but daemon is not responding."
  ok "Docker installed and running"
fi

DOCKER_VERSION=$(docker --version)
ok "Docker: ${DOCKER_VERSION}"

# ── Pull the agent-runtime image ───────────────────────────────────────────────

log "Pulling image: ${AGENT_IMAGE}"
docker pull "${AGENT_IMAGE}"
ok "Image ready: ${AGENT_IMAGE}"

# ── Collect credentials ────────────────────────────────────────────────────────

prompt() {
  # prompt <varname> <prompt_text> [default]
  local var="$1" prompt_text="$2" default="${3:-}"
  if [ "${NON_INTERACTIVE}" = true ]; then
    [ -n "${!var:-}" ] || die "Non-interactive mode: ${var} must be set in the environment."
    return
  fi
  local current="${!var:-}"
  if [ -n "${current}" ]; then
    read -rp "${prompt_text} [${current}]: " input
    [ -n "${input}" ] && printf -v "$var" '%s' "${input}"
  elif [ -n "${default}" ]; then
    read -rp "${prompt_text} [${default}]: " input
    printf -v "$var" '%s' "${input:-${default}}"
  else
    read -rp "${prompt_text}: " input
    printf -v "$var" '%s' "${input}"
  fi
}

echo ""
log "=== Collecting credentials ==="

ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
prompt ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...)"
[[ "${ANTHROPIC_API_KEY}" == sk-ant-* ]] || warn "ANTHROPIC_API_KEY does not start with 'sk-ant-' — double-check this."

GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-}"
prompt GIT_AUTHOR_EMAIL "Agent git author email (recorded in task log entries)"
[[ "${GIT_AUTHOR_EMAIL}" == *@* ]] || die "GIT_AUTHOR_EMAIL must be a valid email address."

GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Agent Bot}"
prompt GIT_AUTHOR_NAME "Agent git author name" "Agent Bot"

# SSH key setup
SSH_KEY_PATH="${SSH_KEY_PATH:-${HOME}/.ssh/id_rsa}"
if [ ! -f "${SSH_KEY_PATH}" ]; then
  warn "SSH key not found at ${SSH_KEY_PATH}"
  if [ "${NON_INTERACTIVE}" = true ]; then
    die "SSH_KEY_PATH=${SSH_KEY_PATH} does not exist. Generate a key or set SSH_KEY_PATH."
  fi
  read -rp "Generate a new ED25519 SSH key pair now? [Y/n]: " gen_key
  if [[ "${gen_key,,}" != "n" ]]; then
    ssh-keygen -t ed25519 -C "${GIT_AUTHOR_EMAIL}" -f "${HOME}/.ssh/id_rsa" -N ""
    SSH_KEY_PATH="${HOME}/.ssh/id_rsa"
    ok "SSH key generated at ${SSH_KEY_PATH}"
    echo ""
    echo "Add this public key to your GitHub account (Settings → SSH and GPG keys):"
    cat "${SSH_KEY_PATH}.pub"
    echo ""
    read -rp "Press Enter once the key is added to GitHub..."
  fi
fi
ok "SSH key: ${SSH_KEY_PATH}"

# Watched workspace SSH URL
WORKSPACE_URL="${WORKSPACE_URL:-}"
prompt WORKSPACE_URL "Workspace SSH URL to watch (e.g. git@github.com:org/workspace.git)"
[[ "${WORKSPACE_URL}" == git@* ]] || warn "WORKSPACE_URL should be an SSH URL (git@github.com:...)"

# ── Write configuration files ──────────────────────────────────────────────────

CONFIG_DIR="${AGENT_CONFIG_DIR}"
SSH_CONFIG_DIR="${CONFIG_DIR}/ssh"

if [ "$(id -u)" -eq 0 ]; then
  log "Writing config to ${CONFIG_DIR} (running as root)"
  mkdir -p "${CONFIG_DIR}" "${SSH_CONFIG_DIR}"

  # Env file (secrets)
  cat > "${CONFIG_DIR}/env" <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME}
GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL}
EOF
  chmod 600 "${CONFIG_DIR}/env"

  # SSH key
  cp "${SSH_KEY_PATH}" "${SSH_CONFIG_DIR}/id_rsa"
  chmod 400 "${SSH_CONFIG_DIR}/id_rsa"

  AGENT_YAML_DEST="${CONFIG_DIR}/agent.yaml"
  ENV_FILE="${CONFIG_DIR}/env"
  SSH_DIR="${SSH_CONFIG_DIR}"
else
  # Unprivileged: write to ~/.config/agent-runtime/
  CONFIG_DIR="${HOME}/.config/agent-runtime"
  SSH_CONFIG_DIR="${CONFIG_DIR}/ssh"
  mkdir -p "${CONFIG_DIR}" "${SSH_CONFIG_DIR}"

  cat > "${CONFIG_DIR}/env" <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME}
GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL}
EOF
  chmod 600 "${CONFIG_DIR}/env"

  cp "${SSH_KEY_PATH}" "${SSH_CONFIG_DIR}/id_rsa"
  chmod 400 "${SSH_CONFIG_DIR}/id_rsa"

  AGENT_YAML_DEST="${CONFIG_DIR}/agent.yaml"
  ENV_FILE="${CONFIG_DIR}/env"
  SSH_DIR="${SSH_CONFIG_DIR}"
  warn "Running unprivileged — systemd setup skipped. Config written to ${CONFIG_DIR}"
fi

# agent.yaml
if [ -f "${AGENT_YAML_DEST}" ]; then
  warn "${AGENT_YAML_DEST} already exists — not overwriting."
else
  cat > "${AGENT_YAML_DEST}" <<EOF
# agent.yaml — agent-runtime configuration
# Edit watches: to add more managed workspaces.
watches:
  - ${WORKSPACE_URL}
enabled: true
jitter_max_seconds: 2
budget:
  max_tokens_per_task: 100000
  max_iterations: 30
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
EOF
  ok "Wrote ${AGENT_YAML_DEST}"
fi

# ── Dry run ────────────────────────────────────────────────────────────────────

log "=== Dry run (enabled: false — bootstrap only) ==="
DRY_RUN_YAML=$(mktemp /tmp/agent-dryrun-XXXXXX.yaml)
cp "${AGENT_YAML_DEST}" "${DRY_RUN_YAML}"
sed -i.bak 's/^enabled:.*/enabled: false/' "${DRY_RUN_YAML}" && rm -f "${DRY_RUN_YAML}.bak"

docker run --rm \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -e GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME}" \
  -e GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL}" \
  -e SSH_KEY_PATH=/agent/ssh/id_rsa \
  -v "${DRY_RUN_YAML}:/agent/agent.yaml:ro" \
  -v "${SSH_DIR}:/agent/ssh:ro" \
  "${AGENT_IMAGE}"

rm -f "${DRY_RUN_YAML}"
ok "Dry run passed — agent config is valid"

if [ "${DRY_RUN_ONLY}" = true ]; then
  log "Dry run complete. Skipping persistent schedule installation (--dry-run-only)."
  exit 0
fi

# ── Systemd timer install (Linux root only) ────────────────────────────────────

if [ "$OS" != "macos" ] && [ "$(id -u)" -eq 0 ] && command -v systemctl &>/dev/null; then
  SYSTEMD_SOURCE_DIR="${REPO_ROOT}/agent-runtime/orchestration/systemd"

  if [ -d "${SYSTEMD_SOURCE_DIR}" ]; then
    log "Installing systemd timer..."
    cp "${SYSTEMD_SOURCE_DIR}/agent-runtime.service" "${SYSTEMD_DIR}/"
    cp "${SYSTEMD_SOURCE_DIR}/agent-runtime.timer"   "${SYSTEMD_DIR}/"

    # Patch the service to use the written config dir if it differs from default
    if [ "${CONFIG_DIR}" != "${AGENT_CONFIG_DIR}" ]; then
      sed -i "s|${AGENT_CONFIG_DIR}|${CONFIG_DIR}|g" "${SYSTEMD_DIR}/agent-runtime.service"
    fi

    systemctl daemon-reload
    systemctl enable --now agent-runtime.timer
    ok "Systemd timer installed and started"
    systemctl status agent-runtime.timer --no-pager
  else
    warn "Systemd unit files not found at ${SYSTEMD_SOURCE_DIR} — skipping timer install."
    warn "Run manually: docker run --rm -v ${AGENT_YAML_DEST}:/agent/agent.yaml:ro ... ${AGENT_IMAGE}"
  fi
else
  echo ""
  log "=== Next steps ==="
  if [ "$OS" = "macos" ]; then
    echo "To run a one-shot activation:"
    echo "  docker run --rm \\"
    echo "    -e ANTHROPIC_API_KEY=... \\"
    echo "    -e GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL} \\"
    echo "    -e SSH_KEY_PATH=/agent/ssh/id_rsa \\"
    echo "    -v ${AGENT_YAML_DEST}:/agent/agent.yaml:ro \\"
    echo "    -v ${SSH_DIR}:/agent/ssh:ro \\"
    echo "    ${AGENT_IMAGE}"
    echo ""
    echo "For a persistent supervisor loop (docker-compose prod profile):"
    echo "  cp ${AGENT_YAML_DEST} ${REPO_ROOT}/agent-runtime/orchestration/agent.yaml"
    echo "  cd ${REPO_ROOT}/agent-runtime/orchestration && docker compose --profile prod up -d"
  else
    warn "Non-root install — systemd not configured. Run the above docker command manually."
  fi
fi

echo ""
ok "Bootstrap complete. Agent is ready."
echo ""
echo "  Config:    ${AGENT_YAML_DEST}"
echo "  Secrets:   ${ENV_FILE}"
echo "  SSH key:   ${SSH_DIR}/id_rsa"
echo ""
echo "To view live agent events:"
echo "  journalctl -u agent-runtime.service -f"
