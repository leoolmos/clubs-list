#!/usr/bin/env bash
# ===========================================================================
# Racket Club Database — arranque
#
# No macOS: dois cliques neste ficheiro.
#   Se o macOS não deixar abrir, no Terminal corre uma vez:
#   chmod +x start.command
#
# No Linux:  bash start.command
# ===========================================================================

set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YEL=$'\033[0;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

echo ""
echo "  Racket Club Database"
echo "  $(pwd)"
echo ""

# --- 1. Node -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  ${RED}Node.js não está instalado.${OFF}"
  echo "  Instala em https://nodejs.org (versão 18 ou superior) e corre isto outra vez."
  echo ""
  read -r -p "  Enter para fechar." _
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ${RED}Node $(node -v) é demasiado antigo.${OFF} É preciso a 18 ou superior (o fetch global só existe a partir daí)."
  echo ""
  read -r -p "  Enter para fechar." _
  exit 1
fi
echo "  ${GREEN}✓${OFF} Node $(node -v)"

# --- 2. Ficheiros ------------------------------------------------------------
MISSING=0
for f in daemon.js seeds.txt racket-club-database.html; do
  if [ -f "$f" ]; then
    echo "  ${GREEN}✓${OFF} $f"
  else
    echo "  ${RED}✗ $f não está nesta pasta${OFF}"
    MISSING=1
  fi
done

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "  Põe os três ficheiros na mesma pasta que este script e tenta de novo."
  echo ""
  read -r -p "  Enter para fechar." _
  exit 1
fi

SEED_COUNT="$(grep -cE '^[A-Za-z]{2}[[:space:]]+https?://' seeds.txt || true)"
echo "  ${GREEN}✓${OFF} ${SEED_COUNT} directórios em seeds.txt"

# --- 3. Porta livre? ---------------------------------------------------------
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "  ${YEL}A porta $PORT já está ocupada.${OFF}"
  echo "  Provavelmente já tens isto a correr. Abre http://localhost:$PORT"
  echo "  Ou corre com outra porta:   PORT=8888 bash start.command"
  echo ""
  read -r -p "  Enter para fechar." _
  exit 1
fi

# --- 4. Estado actual --------------------------------------------------------
echo ""
if [ -f data/clubs.json ]; then
  node daemon.js status 2>/dev/null | sed 's/^/  /'
else
  echo "  ${DIM}Primeira execução — ainda não há nada recolhido.${OFF}"
  echo "  ${DIM}A primeira ronda demora: são 52 páginas de províncias espanholas,${OFF}"
  echo "  ${DIM}com 2 segundos entre pedidos para não sobrecarregar o servidor deles.${OFF}"
fi

# --- 5. Arrancar -------------------------------------------------------------
echo ""
echo "  A arrancar em http://localhost:$PORT"
echo "  ${DIM}Ctrl-C para parar. O que já foi recolhido fica guardado.${OFF}"
echo ""

PORT="$PORT" node daemon.js serve &
DAEMON_PID=$!
trap 'echo ""; echo "  A parar…"; kill $DAEMON_PID 2>/dev/null; exit 0' INT TERM

# esperar que a porta responda antes de abrir o browser
for _ in $(seq 1 25); do
  if node -e "fetch('http://localhost:${PORT}/api/clubs.json').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.4
done

if command -v open >/dev/null 2>&1; then
  open "http://localhost:$PORT"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$PORT" >/dev/null 2>&1
else
  echo "  Abre manualmente: http://localhost:$PORT"
fi

wait $DAEMON_PID
