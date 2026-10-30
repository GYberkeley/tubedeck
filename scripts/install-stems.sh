#!/bin/sh
# Installs Demucs (stem separation) into its own venv, so the helper itself stays stdlib-only.
# Downloads torch (~140 MB on Apple Silicon); the htdemucs model (~84 MB) downloads on first use.
set -eu
HOME_DIR="${TUBEDECK_HOME:-$HOME/.tubedeck}"
VENV="$HOME_DIR/stems-venv"
PYTHON="${PYTHON:-python3}"
"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install -q -U pip
"$VENV/bin/python" -m pip install -q -U demucs numpy  # demucs 4.1.0 imports numpy without declaring it
"$VENV/bin/python" -m demucs --help > /dev/null
echo "Demucs installed in $VENV. Restart the helper (python3 server.py) to enable stems."
