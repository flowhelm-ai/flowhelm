#!/bin/bash
# FlowHelm Installer
#
# Non-interactive, idempotent installation script.
#
# Linux (Ubuntu 24.04 LTS):
#   Installs Podman, Node.js, FlowHelm CLI, and optionally runs `flowhelm admin init`.
#   Requires root.
#
# macOS (Tahoe 26+, Apple Silicon):
#   Installs Node.js (via Homebrew), FlowHelm CLI. Checks for Apple Container CLI.
#   Does NOT require root (Homebrew runs as user).
#
# Usage:
#   curl -fsSL https://flowhelm.ai/install.sh | bash
#   curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --version 1.0.0
#   curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --dry-run
#   curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --no-init
#   curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --upgrade

set -euo pipefail

# ─── Constants ──────────────────────────────────────────────────────────────

FLOWHELM_VERSION="${FLOWHELM_VERSION:-latest}"
NODE_MAJOR=22
MIN_PODMAN_MAJOR=4

# ─── State ──────────────────────────────────────────────────────────────────

DRY_RUN=false
NO_INIT=false
UPGRADE=false
OS_ID=""
OS_VERSION=""
OS_ARCH=""
IS_MACOS=false

# ─── Output helpers ─────────────────────────────────────────────────────────

log() {
  echo "[flowhelm] $*"
}

warn() {
  echo "[flowhelm] WARNING: $*" >&2
}

die() {
  echo "[flowhelm] ERROR: $*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

# ─── Argument parsing ──────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        FLOWHELM_VERSION="$2"
        shift 2
        ;;
      --version=*)
        FLOWHELM_VERSION="${1#*=}"
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --no-init)
        NO_INIT=true
        shift
        ;;
      --upgrade)
        UPGRADE=true
        shift
        ;;
      --help|-h)
        echo "FlowHelm Installer"
        echo ""
        echo "Usage: curl -fsSL https://flowhelm.ai/install.sh | bash"
        echo ""
        echo "Options:"
        echo "  --version <ver>  Install a specific version (default: latest)"
        echo "  --dry-run        Show what would be installed without doing it"
        echo "  --no-init        Skip 'flowhelm admin init' after install"
        echo "  --upgrade        Upgrade existing installation"
        echo "  --help           Show this help"
        exit 0
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
  done
}

# ─── Platform detection ─────────────────────────────────────────────────────

detect_os() {
  local kernel
  kernel="$(uname -s)"

  case "$kernel" in
    Darwin)
      detect_macos
      ;;
    Linux)
      detect_linux
      ;;
    *)
      die "Unsupported OS: $kernel. FlowHelm requires Linux or macOS."
      ;;
  esac
}

detect_macos() {
  IS_MACOS=true
  OS_ID="macos"
  OS_ARCH="$(uname -m)"

  local macos_version
  macos_version="$(sw_vers -productVersion 2>/dev/null || echo "0")"
  OS_VERSION="$macos_version"

  local major="${macos_version%%.*}"

  if [ "$OS_ARCH" != "arm64" ]; then
    warn "Intel Mac detected. Apple Container requires Apple Silicon (M1+)."
    warn "FlowHelm will use Podman as a fallback: brew install podman"
  fi

  if [ "$major" -ge 26 ] 2>/dev/null; then
    log "OS: macOS $macos_version Tahoe ($OS_ARCH)"
  elif [ "$major" -ge 15 ] 2>/dev/null; then
    warn "macOS $macos_version detected. Apple Container requires macOS Tahoe (26+)."
    warn "FlowHelm will use Podman as a fallback: brew install podman"
    log "OS: macOS $macos_version ($OS_ARCH) [pre-Tahoe, Podman fallback]"
  else
    die "Unsupported macOS version: $macos_version. Requires macOS 15+ (Podman) or 26+ (Apple Container)."
  fi
}

detect_linux() {
  if [ ! -f /etc/os-release ]; then
    die "Cannot detect OS: /etc/os-release not found. FlowHelm requires Ubuntu 24.04 LTS."
  fi

  # shellcheck source=/dev/null
  . /etc/os-release

  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"
  OS_ARCH="$(uname -m)"

  case "$OS_ID" in
    ubuntu)
      case "$OS_VERSION" in
        24.04*)
          log "OS: Ubuntu 24.04 LTS ($OS_ARCH)"
          ;;
        22.04*)
          warn "Ubuntu 22.04 is best-effort. Ubuntu 24.04 LTS is recommended."
          log "OS: Ubuntu 22.04 LTS ($OS_ARCH) [best-effort]"
          ;;
        *)
          die "Unsupported Ubuntu version: $OS_VERSION. Supported: 24.04, 22.04."
          ;;
      esac
      ;;
    debian)
      local deb_major="${OS_VERSION%%.*}"
      if [ "$deb_major" -ge 12 ] 2>/dev/null; then
        log "OS: Debian $OS_VERSION ($OS_ARCH) [best-effort]"
      else
        die "Unsupported Debian version: $OS_VERSION. Requires Debian 12+."
      fi
      ;;
    *)
      die "Unsupported OS: $OS_ID. FlowHelm requires Ubuntu 24.04 LTS (or Debian 12+)."
      ;;
  esac
}

# ─── Prerequisite checks ───────────────────────────────────────────────────

check_root() {
  if [ "$IS_MACOS" = true ]; then
    # macOS install does not require root (Homebrew runs as user)
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    die "This script must be run as root. Try: sudo bash -c \"\$(curl -fsSL https://flowhelm.ai/install.sh)\""
  fi
}

check_internet() {
  log "Checking internet connectivity..."
  if ! curl -fsSL -o /dev/null --connect-timeout 10 https://registry.npmjs.org/ 2>/dev/null; then
    die "No internet connectivity. Cannot reach registry.npmjs.org."
  fi
}

check_systemd() {
  if [ "$IS_MACOS" = true ]; then
    # macOS uses launchd, not systemd
    return 0
  fi
  if [ ! -d /run/systemd/system ]; then
    die "systemd not detected. FlowHelm requires systemd for service management."
  fi
}

# ─── macOS-specific installation ──────────────────────────────────────────

check_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    log "Homebrew found: $(brew --prefix)"
    return 0
  fi
  die "Homebrew not found. Install it first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
}

check_apple_container() {
  if command -v container >/dev/null 2>&1; then
    local version
    version="$(container --version 2>/dev/null || echo 'unknown')"
    log "Apple Container CLI: $version"
    return 0
  fi

  local major="${OS_VERSION%%.*}"
  if [ "$major" -ge 26 ] 2>/dev/null && [ "$OS_ARCH" = "arm64" ]; then
    warn "Apple Container CLI not found."
    warn "Install from: https://github.com/apple/container/releases"
    warn "FlowHelm will still install, but 'flowhelm doctor' will report this."
  fi
}

install_podman_macos() {
  if command -v podman >/dev/null 2>&1; then
    local podman_version
    podman_version="$(podman --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo '0.0.0')"
    local podman_major="${podman_version%%.*}"
    if [ "$podman_major" -ge "$MIN_PODMAN_MAJOR" ] 2>/dev/null; then
      log "Podman $podman_version already installed (>= $MIN_PODMAN_MAJOR.x)"
    else
      warn "Podman $podman_version is too old (need >= $MIN_PODMAN_MAJOR.x). Upgrading..."
      run brew upgrade podman
    fi
  else
    log "Installing Podman via Homebrew..."
    run brew install podman
  fi

  # Initialize podman machine if not present
  if ! podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
    log "Initializing Podman machine VM..."
    run podman machine init
  fi

  # Start podman machine if not running
  if ! podman machine list --format '{{.Running}}' 2>/dev/null | grep -q 'true'; then
    log "Starting Podman machine VM..."
    run podman machine start
  else
    log "Podman machine already running"
  fi
}

install_node_macos() {
  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '0')"
    if [ "$node_version" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      log "Node.js $(node --version) already installed (>= $NODE_MAJOR)"
      return 0
    fi
    warn "Node.js v$node_version is too old (need >= $NODE_MAJOR). Installing..."
  fi

  log "Installing Node.js $NODE_MAJOR via Homebrew..."
  run brew install "node@$NODE_MAJOR"

  if [ "$DRY_RUN" = false ]; then
    log "Node.js $(node --version) installed"
  fi
}

# ─── Linux-specific installation ──────────────────────────────────────────

install_podman() {
  if command -v podman >/dev/null 2>&1; then
    local podman_version
    podman_version="$(podman --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' || echo '0.0.0')"
    local podman_major="${podman_version%%.*}"
    if [ "$podman_major" -ge "$MIN_PODMAN_MAJOR" ] 2>/dev/null; then
      log "Podman $podman_version already installed (>= $MIN_PODMAN_MAJOR.x)"
      return 0
    fi
    warn "Podman $podman_version is too old (need >= $MIN_PODMAN_MAJOR.x). Upgrading..."
  fi

  log "Installing Podman and rootless dependencies..."
  run apt-get update -qq
  run apt-get install -y -qq podman slirp4netns fuse-overlayfs uidmap crun >/dev/null

  if [ "$DRY_RUN" = false ]; then
    local installed_version
    installed_version="$(podman --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' || echo 'unknown')"
    log "Podman $installed_version installed"
  fi
}

install_node_linux() {
  if command -v node >/dev/null 2>&1; then
    local node_version
    node_version="$(node --version 2>/dev/null | grep -oP '\d+' | head -1 || echo '0')"
    if [ "$node_version" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      log "Node.js $(node --version) already installed (>= $NODE_MAJOR)"
      return 0
    fi
    warn "Node.js v$node_version is too old (need >= $NODE_MAJOR). Installing..."
  fi

  log "Installing Node.js $NODE_MAJOR..."

  # Add NodeSource repository
  if [ "$DRY_RUN" = false ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    log "Node.js $(node --version) installed"
  else
    log "[dry-run] curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    log "[dry-run] apt-get install -y nodejs"
  fi
}

# ─── FlowHelm installation ───────────────────────────────────────────────

install_flowhelm() {
  if [ "$FLOWHELM_VERSION" = "latest" ]; then
    log "Installing FlowHelm (latest)..."
    run npm install -g flowhelm
  else
    log "Installing FlowHelm v$FLOWHELM_VERSION..."
    run npm install -g "flowhelm@$FLOWHELM_VERSION"
  fi

  if [ "$DRY_RUN" = false ]; then
    local installed_version
    installed_version="$(flowhelm --version 2>/dev/null || echo 'unknown')"
    log "FlowHelm $installed_version installed to $(which flowhelm)"
  fi
}

# ─── Upgrade ────────────────────────────────────────────────────────────────

upgrade_flowhelm() {
  log "Upgrading FlowHelm..."

  if [ "$FLOWHELM_VERSION" = "latest" ]; then
    run npm update -g flowhelm
  else
    run npm install -g "flowhelm@$FLOWHELM_VERSION"
  fi

  if [ "$DRY_RUN" = false ]; then
    local installed_version
    installed_version="$(flowhelm --version 2>/dev/null || echo 'unknown')"
    log "FlowHelm upgraded to $installed_version"
  fi

  if [ "$IS_MACOS" = true ]; then
    # macOS: restart launchd service if loaded
    log "Restarting FlowHelm launchd service..."
    if launchctl list 2>/dev/null | grep -q 'ai.flowhelm'; then
      if [ "$DRY_RUN" = false ]; then
        launchctl kickstart -k "gui/$(id -u)/ai.flowhelm" 2>/dev/null || \
          warn "Could not restart launchd service"
      else
        log "[dry-run] launchctl kickstart -k gui/$(id -u)/ai.flowhelm"
      fi
    else
      log "  No launchd service found to restart."
    fi
  else
    # Linux: write version and restart user services
    if [ "$DRY_RUN" = false ] && [ -d /etc/flowhelm ]; then
      flowhelm --version > /etc/flowhelm/version 2>/dev/null || true
    fi

    log "Restarting FlowHelm user services..."
    local restarted=0
    for user_home in /home/flowhelm-*/; do
      if [ ! -d "$user_home" ]; then continue; fi
      local username
      username="$(basename "$user_home")"
      if systemctl is-active --quiet "user@$(id -u "$username").service" 2>/dev/null; then
        log "  Restarting service for $username..."
        if [ "$DRY_RUN" = false ]; then
          systemctl --user --machine="$username@.host" restart flowhelm.service 2>/dev/null || \
            warn "Could not restart service for $username"
        fi
        restarted=$((restarted + 1))
      fi
    done

    if [ $restarted -eq 0 ]; then
      log "  No running services found to restart."
    else
      log "  Restarted $restarted service(s)."
    fi
  fi
}

# ─── Initialization ────────────────────────────────────────────────────────

run_init() {
  if [ "$IS_MACOS" = true ]; then
    # macOS: single-user, run setup instead of admin init
    log "Run 'flowhelm setup' to configure your instance."
    return 0
  fi

  log "Running flowhelm admin init..."
  if [ "$DRY_RUN" = false ]; then
    flowhelm admin init
  else
    log "[dry-run] flowhelm admin init"
  fi
}

# ─── Summary ────────────────────────────────────────────────────────────────

print_summary() {
  log ""
  if [ "$UPGRADE" = true ]; then
    log "Upgrade complete."
  else
    log "Installation complete."
  fi
  log ""

  if [ "$DRY_RUN" = false ]; then
    log "Installed:"
    if [ "$IS_MACOS" = true ]; then
      log "  Node.js:          $(node --version 2>/dev/null || echo 'not installed')"
      log "  FlowHelm:         $(flowhelm --version 2>/dev/null || echo 'not installed')"
      local major="${OS_VERSION%%.*}"
      if [ "$major" -ge 26 ] 2>/dev/null && [ "$OS_ARCH" = "arm64" ]; then
        log "  Apple Container:  $(container --version 2>/dev/null || echo 'not installed')"
      else
        log "  Podman:           $(podman --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'not installed')"
        log "  Podman machine:   $(podman machine list --format '{{.Name}} ({{.Running}})' 2>/dev/null | head -1 || echo 'not initialized')"
      fi
    else
      log "  Podman:   $(podman --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' || echo 'not installed')"
      log "  Node.js:  $(node --version 2>/dev/null || echo 'not installed')"
      log "  FlowHelm: $(flowhelm --version 2>/dev/null || echo 'not installed')"
    fi
    log ""
  fi

  if [ "$UPGRADE" = false ]; then
    log "Next steps:"
    if [ "$IS_MACOS" = true ]; then
      log "  1. Run:  flowhelm setup"
      log "  2. Run:  flowhelm doctor"
      log ""
      local major="${OS_VERSION%%.*}"
      if [ "$major" -ge 26 ] 2>/dev/null && ! command -v container >/dev/null 2>&1; then
        log "  Note: Install Apple Container CLI from:"
        log "  https://github.com/apple/container/releases"
        log ""
      fi
    else
      log "  1. Add a user:    flowhelm admin add-user yourname --ssh-key ~/.ssh/yourname.pub"
      log "  2. User logs in:  ssh flowhelm-yourname@$(hostname -f 2>/dev/null || hostname)"
      log "  3. User runs:     flowhelm setup"
      log ""
    fi
    log "Documentation: https://flowhelm.ai/docs"
  fi
}

# ─── Main ───────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  log "FlowHelm Installer"
  log ""

  detect_os
  check_root
  check_internet

  if [ "$IS_MACOS" = true ]; then
    check_homebrew
    install_node_macos

    local major="${OS_VERSION%%.*}"
    if [ "$major" -ge 26 ] 2>/dev/null && [ "$OS_ARCH" = "arm64" ]; then
      # macOS Tahoe+ with Apple Silicon: prefer Apple Container
      check_apple_container
    else
      # Pre-Tahoe or Intel: use Podman via podman machine
      install_podman_macos
    fi
  else
    check_systemd
    install_podman
    install_node_linux
  fi

  if [ "$UPGRADE" = true ]; then
    upgrade_flowhelm
  else
    install_flowhelm
  fi

  # Write version tracking file (Linux only — macOS is single-user)
  if [ "$IS_MACOS" = false ] && [ "$DRY_RUN" = false ] && [ -d /etc/flowhelm ]; then
    flowhelm --version > /etc/flowhelm/version 2>/dev/null || true
  fi

  if [ "$NO_INIT" != true ] && [ "$UPGRADE" != true ]; then
    run_init
  fi

  print_summary
}

main "$@"
