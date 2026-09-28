#!/bin/bash
# vinyl-spin: двойной клик в Finder открывает редактор в Chrome с кнопкой «Рендер ролика».
# Окно Терминала — это журнал сервера, печатать в нём ничего не нужно. Закрыл окно — сервер остановился.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "Не найден Node.js. Поставь его с https://nodejs.org (или «brew install node») и запусти снова."
  read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно…"; exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "Не найден ffmpeg. Поставь его («brew install ffmpeg») и запусти снова."
  read -n 1 -s -r -p "Нажми любую клавишу, чтобы закрыть окно…"; exit 1
fi
exec node studio.mjs
