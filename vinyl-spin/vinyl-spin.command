#!/bin/bash
# vinyl-spin: двойной клик в Finder открывает редактор в Chrome с кнопкой «Рендер ролика».
# Окно Терминала — это журнал сервера, печатать в нём ничего не нужно. Закрыл окно — сервер остановился.
cd "$(dirname "$0")" || exit 1

pause_exit() { echo; read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно…"; exit 1; }

# Finder запускает этот файл без твоих настроек оболочки, поэтому node и ffmpeg ищем сами:
# сначала спрашиваем твою обычную оболочку (там видны nvm, fnm, volta), потом стандартные места.
from_shell() { "${SHELL:-/bin/zsh}" -ilc "command -v $1" 2>/dev/null | grep '^/' | tail -1; }

# Node: берём самый новый из найденных, нужен 18 или новее
best_node=""; best_v=0
for n in "$(from_shell node)" "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node \
         "$HOME"/.fnm/aliases/default/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case "$v" in ''|*[!0-9]*) continue;; esac
  if [ "$v" -gt "$best_v" ]; then best_node="$n"; best_v="$v"; fi
done
if [ -z "$best_node" ]; then
  echo "Не найден Node.js. Поставь его с https://nodejs.org и запусти снова."; pause_exit
fi
if [ "$best_v" -lt 18 ]; then
  echo "Нашёлся только старый Node.js $("$best_node" -v) ($best_node), а нужен 18 или новее."
  echo "Поставь свежий с https://nodejs.org и запусти снова."; pause_exit
fi

# ffmpeg: из твоей оболочки, иначе из стандартных мест
ff="$(from_shell ffmpeg)"
for c in "$ff" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg; do [ -x "$c" ] && { ff="$c"; break; }; done
if [ ! -x "$ff" ]; then
  echo "Не найден ffmpeg. Поставь его («brew install ffmpeg») и запусти снова."; pause_exit
fi

# studio.mjs вызывает ffmpeg и ffprobe по имени — ставим их папку первой в PATH
export PATH="$(dirname "$ff"):$(dirname "$best_node"):$PATH"
echo "Node $("$best_node" -v): $best_node"
echo "ffmpeg: $ff"
"$best_node" studio.mjs || pause_exit
