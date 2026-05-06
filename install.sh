#!/bin/bash
set -e

INSTALL_DIR="$HOME/.polkadot"
REPO="paritytech/playground-cli"
BIN="dot"

# 1) Detect platform
OS=$(uname -s); case "$OS" in Linux) OS=linux;; Darwin) OS=darwin;; *) echo "Unsupported OS: $OS"; exit 1;; esac
ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) echo "Unsupported arch: $ARCH"; exit 1;; esac
ASSET="$BIN-$OS-$ARCH"

# 2) Resolve release tag
#
#   Use VERSION to install a specific tag. Otherwise, prefer GitHub's no-body
#   `releases/latest` redirect. This avoids api.github.com quota while keeping
#   "latest" tied to the same GitHub release source used for the binary
#   download. jsDelivr is CDN-backed and can lag a freshly published release,
#   so keep it as fallback only.
if [ -n "$VERSION" ]; then
  TAG="$VERSION"
else
  TAG=$(curl -fsSI -H "Cache-Control: no-cache" -H "Pragma: no-cache" "https://github.com/$REPO/releases/latest" \
        | sed -n 's|^[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*.*/tag/\(.*\)$|\1|p' \
        | tr -d '\r' | head -n1) || true
  if [ -z "$TAG" ]; then
    TAG=$(curl -fsSL "https://data.jsdelivr.com/v1/packages/gh/$REPO/resolved" \
          | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n1) || true
  fi
fi
[ -z "$TAG" ] && echo "Could not determine latest release" && exit 1
case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac

# 3) Install binary
spin() { while true; do for c in '|' '/' '-' '\'; do printf "\r%s %s" "$1" "$c"; sleep 0.1; done; done; }
spin "Installing dot ($OS/$ARCH) $TAG" &
SPIN_PID=$!
trap "kill $SPIN_PID 2>/dev/null" EXIT

mkdir -p "$INSTALL_DIR/bin" "$HOME/.local/bin"
curl -fsSL "https://github.com/$REPO/releases/download/$TAG/$ASSET" -o "$INSTALL_DIR/bin/$BIN"
chmod +x "$INSTALL_DIR/bin/$BIN"
if [ "$OS" = "darwin" ]; then
  codesign --sign - --force "$INSTALL_DIR/bin/$BIN" 2>/dev/null || true
  xattr -c "$INSTALL_DIR/bin/$BIN" 2>/dev/null || true
fi
ln -sf "$INSTALL_DIR/bin/$BIN" "$HOME/.local/bin/$BIN"

kill $SPIN_PID 2>/dev/null; wait $SPIN_PID 2>/dev/null || true; trap - EXIT
printf "\rInstalled dot (%s/%s) %s   \n" "$OS" "$ARCH" "$TAG"

# 4) Add to PATH
append_once() {
  local file="$1" line="$2"
  grep -Fqx "$line" "$file" 2>/dev/null || printf "\n%s\n" "$line" >> "$file"
}
if command -v bash >/dev/null 2>&1; then
  append_once "$HOME/.bashrc" 'export PATH="$HOME/.polkadot/bin:$HOME/.local/bin:$PATH"'
  append_once "$HOME/.bash_profile" '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"'
fi
if command -v zsh >/dev/null 2>&1; then
  append_once "$HOME/.zshrc" 'export PATH="$HOME/.polkadot/bin:$HOME/.local/bin:$PATH"'
fi
if command -v fish >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/fish"
  append_once "$HOME/.config/fish/config.fish" 'fish_add_path $HOME/.polkadot/bin $HOME/.local/bin'
fi

export PATH="$INSTALL_DIR/bin:$HOME/.local/bin:$PATH"

echo ""
echo -e "dot is ready! Running: \033[1mdot init\033[0m"
echo ""
if ! "$INSTALL_DIR/bin/$BIN" init; then
  INIT_EXIT=$?
  echo -e "\n\033[33mInit did not complete. Run \033[1mdot init\033[0;33m when ready.\033[0m" >&2
  exit "$INIT_EXIT"
fi
