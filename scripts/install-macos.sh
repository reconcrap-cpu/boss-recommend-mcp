#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@reconcrap/boss-recommend-mcp"
DEFAULT_NODE_VERSION="${BOSS_RECOMMEND_NODE_VERSION:-22}"
DEFAULT_NVM_VERSION="${BOSS_RECOMMEND_NVM_VERSION:-v0.40.4}"

NODE_VERSION="$DEFAULT_NODE_VERSION"
NVM_VERSION="$DEFAULT_NVM_VERSION"
AGENT="${BOSS_RECOMMEND_AGENT:-}"
DRY_RUN=0
SKIP_DOCTOR=0
SKIP_LLM_CONFIG=0
BASE_URL="${BOSS_RECOMMEND_BASE_URL:-https://api.openai.com/v1}"
API_KEY="${BOSS_RECOMMEND_API_KEY:-}"
MODEL="${BOSS_RECOMMEND_MODEL:-gpt-4.1-mini}"
THINKING_LEVEL="${BOSS_RECOMMEND_THINKING_LEVEL:-low}"
GREETING_MESSAGE="${BOSS_RECOMMEND_GREETING_MESSAGE:-Hi同学，能麻烦发下简历吗？}"

usage() {
  cat <<'EOF'
Install boss-recommend-mcp on macOS with nvm-backed npm globals.

Usage:
  install-macos.sh [--agent <agent|all>] [--node-version <version>] [--nvm-version <tag>] [--dry-run] [--skip-doctor] [--skip-llm-config]

Examples:
  curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash
  curl -fsSL https://raw.githubusercontent.com/reconcrap-cpu/boss-recommend-mcp/main/scripts/install-macos.sh | bash -s -- --agent openclaw

Supported agents: cursor, trae, trae-cn, claude, openclaw, qclaw, all

LLM config can be supplied non-interactively with:
  BOSS_RECOMMEND_BASE_URL, BOSS_RECOMMEND_API_KEY, BOSS_RECOMMEND_MODEL,
  BOSS_RECOMMEND_THINKING_LEVEL, BOSS_RECOMMEND_GREETING_MESSAGE
EOF
}

log() {
  printf '%s\n' "[boss-recommend-mcp] $*"
}

die() {
  printf '%s\n' "[boss-recommend-mcp] ERROR: $*" >&2
  exit 1
}

run() {
  log "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      [ "$#" -ge 2 ] || die "--agent requires a value"
      AGENT="$2"
      shift 2
      ;;
    --node-version)
      [ "$#" -ge 2 ] || die "--node-version requires a value"
      NODE_VERSION="$2"
      shift 2
      ;;
    --nvm-version)
      [ "$#" -ge 2 ] || die "--nvm-version requires a value"
      NVM_VERSION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-doctor)
      SKIP_DOCTOR=1
      shift
      ;;
    --skip-llm-config)
      SKIP_LLM_CONFIG=1
      shift
      ;;
    --base-url)
      [ "$#" -ge 2 ] || die "--base-url requires a value"
      BASE_URL="$2"
      shift 2
      ;;
    --api-key)
      [ "$#" -ge 2 ] || die "--api-key requires a value"
      API_KEY="$2"
      shift 2
      ;;
    --model)
      [ "$#" -ge 2 ] || die "--model requires a value"
      MODEL="$2"
      shift 2
      ;;
    --thinking-level)
      [ "$#" -ge 2 ] || die "--thinking-level requires a value"
      THINKING_LEVEL="$2"
      shift 2
      ;;
    --greeting-message)
      [ "$#" -ge 2 ] || die "--greeting-message requires a value"
      GREETING_MESSAGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

prompt_text() {
  local label="$1"
  local default_value="$2"
  local secret="${3:-0}"
  local value
  if [ ! -r /dev/tty ]; then
    return 1
  fi
  if [ "$secret" -eq 1 ]; then
    printf '%s' "${label}: " > /dev/tty
    IFS= read -r -s value < /dev/tty || return 1
    printf '\n' > /dev/tty
  elif [ -n "$default_value" ]; then
    printf '%s' "${label} [${default_value}]: " > /dev/tty
    IFS= read -r value < /dev/tty || return 1
    if [ -z "$value" ]; then
      value="$default_value"
    fi
  else
    printf '%s' "${label}: " > /dev/tty
    IFS= read -r value < /dev/tty || return 1
  fi
  printf '%s' "$value"
}

if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run on non-macOS host; skipping platform enforcement"
  else
    die "This bootstrap script is for macOS. Use npm install -g ${PACKAGE_NAME}@latest on other platforms."
  fi
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

load_nvm() {
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
}

install_nvm() {
  if command -v nvm >/dev/null 2>&1; then
    return
  fi
  log "nvm was not found; installing ${NVM_VERSION} into ${NVM_DIR}"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "+ curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash"
    return
  fi
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  load_nvm
  command -v nvm >/dev/null 2>&1 || die "nvm installed but is not available in this shell. Open a new terminal and rerun this script."
}

load_nvm
install_nvm

run nvm install "$NODE_VERSION"
run nvm alias default "$NODE_VERSION"
run nvm use "$NODE_VERSION"

if [ "$DRY_RUN" -eq 0 ]; then
  NODE_PATH="$(command -v node || true)"
  NPM_PATH="$(command -v npm || true)"
  NPM_PREFIX="$(npm config get prefix || true)"
  log "node: ${NODE_PATH}"
  log "npm: ${NPM_PATH}"
  log "npm prefix: ${NPM_PREFIX}"

  case "$NPM_PREFIX" in
    /usr/local|/usr/local/*)
      die "npm is still using /usr/local. Reload nvm and rerun this script; do not use sudo npm install -g."
      ;;
  esac
  case "$NPM_PREFIX" in
    "$NVM_DIR"/*)
      ;;
    *)
      die "npm prefix is not under ${NVM_DIR}. Current prefix: ${NPM_PREFIX}"
      ;;
  esac
else
  log "+ verify: npm config get prefix must be under ${NVM_DIR}, not /usr/local"
fi

run npm -g i "${PACKAGE_NAME}@latest"
run boss-recommend-mcp where

INSTALL_ARGS=(install --mcp-launch global-wrapper)
DOCTOR_ARGS=(doctor)
if [ -n "$AGENT" ]; then
  INSTALL_ARGS+=(--agent "$AGENT")
  DOCTOR_ARGS+=(--agent "$AGENT")
fi

run boss-recommend-mcp "${INSTALL_ARGS[@]}"

if [ "$SKIP_LLM_CONFIG" -eq 0 ]; then
  log "LLM screening config is required before running candidate screening."
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ -r /dev/tty ]; then
      BASE_URL="$(prompt_text "LLM base URL" "$BASE_URL")"
      MODEL="$(prompt_text "LLM model" "$MODEL")"
      THINKING_LEVEL="$(prompt_text "LLM thinking level" "$THINKING_LEVEL")"
      GREETING_MESSAGE="$(prompt_text "Greeting message for candidates" "$GREETING_MESSAGE")"
      if [ -z "$API_KEY" ]; then
        API_KEY="$(prompt_text "LLM API key (input hidden)" "" 1)"
      fi
    fi
    if [ -z "$BASE_URL" ] || [ -z "$API_KEY" ] || [ -z "$MODEL" ]; then
      cat >&2 <<EOF
[boss-recommend-mcp] LLM config is still required.
[boss-recommend-mcp] Ask the user for:
  1. LLM base URL
  2. LLM API key
  3. LLM model name
[boss-recommend-mcp] Then run:
  boss-recommend-mcp config set --base-url <baseUrl> --api-key <apiKey> --model <model> --thinking-level ${THINKING_LEVEL}
EOF
      exit 2
    fi
  fi

  CONFIG_ARGS=(config set --base-url "$BASE_URL" --api-key "$API_KEY" --model "$MODEL")
  if [ -n "$THINKING_LEVEL" ]; then
    CONFIG_ARGS+=(--thinking-level "$THINKING_LEVEL")
  fi
  if [ -n "$GREETING_MESSAGE" ]; then
    CONFIG_ARGS+=(--greeting-message "$GREETING_MESSAGE")
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "+ boss-recommend-mcp config set --base-url ${BASE_URL:-<baseUrl>} --api-key <hidden> --model ${MODEL:-<model>} --thinking-level ${THINKING_LEVEL:-<level>}"
  else
    log "+ boss-recommend-mcp config set --base-url ${BASE_URL} --api-key <hidden> --model ${MODEL}"
    boss-recommend-mcp "${CONFIG_ARGS[@]}"
  fi
else
  log "Skipping LLM config because --skip-llm-config was provided."
fi

if [ "$SKIP_DOCTOR" -eq 0 ]; then
  log "+ boss-recommend-mcp ${DOCTOR_ARGS[*]}"
  if [ "$DRY_RUN" -eq 0 ]; then
    if ! boss-recommend-mcp "${DOCTOR_ARGS[@]}"; then
      log "doctor reported follow-up work. The npm package install still completed."
    fi
  fi
fi

cat <<EOF
[boss-recommend-mcp] install complete.
[boss-recommend-mcp] Future upgrades:
  npm -g i ${PACKAGE_NAME}@latest
  boss-recommend-mcp where
EOF
