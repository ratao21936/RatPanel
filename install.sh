#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# RatPanel — Instalador Automático
# Uso: bash <(curl -fsSL https://raw.githubusercontent.com/ratao21936/RatPanel/main/install.sh)
# ─────────────────────────────────────────────────────────

set -e

# ─── Cores ───────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}➜${NC} $1"; }
ok()    { echo -e "${GREEN}✔${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✖${NC} $1"; exit 1; }

# ─── Banner ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ██████╗  █████╗ ████████╗██████╗  █████╗ ███╗   ██╗███████╗██╗     "
echo "  ██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗██╔══██╗████╗  ██║██╔════╝██║     "
echo "  ██████╔╝███████║   ██║   ██████╔╝███████║██╔██╗ ██║█████╗  ██║     "
echo "  ██╔══██╗██╔══██║   ██║   ██╔═══╝ ██╔══██║██║╚██╗██║██╔══╝  ██║     "
echo "  ██║  ██║██║  ██║   ██║   ██║     ██║  ██║██║ ╚████║███████╗███████╗"
echo "  ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝"
echo -e "${NC}"
echo -e "         ${BOLD}Instalador Automático${NC}"
echo ""

# ─── 1. Verificar Node.js ────────────────────────────────
info "Verificando Node.js..."
if ! command -v node &> /dev/null; then
  error "Node.js não encontrado.

  Instale o Node.js 18+ primeiro:

    # Ubuntu/Debian
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs

    # macOS
    brew install node"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ é necessário. Versão atual: $(node -v)"
fi
ok "Node.js $(node -v) encontrado"

# ─── 2. Verificar npm ────────────────────────────────────
if ! command -v npm &> /dev/null; then
  error "npm não encontrado. Reinstale o Node.js."
fi
ok "npm $(npm -v) encontrado"

# ─── 3. Verificar git ────────────────────────────────────
if ! command -v git &> /dev/null; then
  error "git não encontrado. Instale com:
    # Ubuntu/Debian
    sudo apt install -y git

    # macOS
    brew install git"
fi
ok "git encontrado"

# ─── 4. Definir diretório de instalação ──────────────────
INSTALL_DIR="${RATPANEL_DIR:-$HOME/RatPanel}"

if [ -d "$INSTALL_DIR" ]; then
  warn "O diretório $INSTALL_DIR já existe."
  read -p "Deseja sobrescrever? (s/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[SsYy]$ ]]; then
    info "Instalação cancelada pelo usuário."
    exit 0
  fi
  rm -rf "$INSTALL_DIR"
fi

info "Clonando repositório em $INSTALL_DIR..."
git clone --depth=1 https://github.com/ratao21936/RatPanel.git "$INSTALL_DIR" \
  || error "Falha ao clonar. Verifique sua conexão com a internet."
ok "Repositório clonado"

# ─── 5. Instalar dependências ────────────────────────────
cd "$INSTALL_DIR/backend" || error "Pasta 'backend' não encontrada."

info "Instalando dependências do backend (pode demorar um pouco)..."
npm install --omit=dev --silent || error "Falha no npm install"
ok "Dependências instaladas"

# ─── 6. Perguntar a porta ────────────────────────────────
echo ""
read -p "$(echo -e "${CYAN}➜${NC} Porta do servidor [6002]: ")" PORT_INPUT
PORT_INPUT=${PORT_INPUT:-6002}

# ─── 7. Criar .env com JWT_SECRET aleatório ──────────────
info "Configurando arquivo .env..."

if [ -f ".env" ]; then
  warn "Já existe um .env. Fazendo backup para .env.backup"
  mv .env ".env.backup.$(date +%s)"
fi

# Gera JWT_SECRET aleatório (64 caracteres hex)
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat > .env <<EOF
# ─── RatPanel — Configuração ─────────────────────────────
# Este arquivo foi gerado automaticamente pelo install.sh
# Para trocar o JWT_SECRET manualmente, veja INSTALL.md

PORT=$PORT_INPUT
JWT_SECRET=$JWT_SECRET
EOF

ok "Arquivo .env criado"
ok "JWT_SECRET gerado automaticamente (64 caracteres)"
ok "Porta configurada: $PORT_INPUT"

# ─── 8. Finalizar ────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✔  RatPanel instalado com sucesso!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo ""
echo -e "  📁 Local:      ${CYAN}$INSTALL_DIR${NC}"
echo -e "  🚀 Iniciar:    ${CYAN}cd $INSTALL_DIR/backend && npm start${NC}"
echo -e "  🌐 Acessar:    ${CYAN}http://localhost:$PORT_INPUT/login.html${NC}"
echo ""
echo -e "  👤 Login padrão:  ${YELLOW}admin / admin123${NC}"
echo -e "  ${RED}${BOLD}⚠  Troque a senha imediatamente após o primeiro login!${NC}"
echo ""
echo -e "  🔑 JWT_SECRET: salvo em ${CYAN}$INSTALL_DIR/backend/.env${NC}"
echo -e "  ${YELLOW}   Pra trocar depois, veja o INSTALL.md${NC}"
echo ""

read -p "$(echo -e "${CYAN}➜${NC} Deseja iniciar o RatPanel agora? (s/N): ")" -n 1 -r
echo ""
if [[ $REPLY =~ ^[SsYy]$ ]]; then
  info "Iniciando RatPanel..."
  npm start
fi
