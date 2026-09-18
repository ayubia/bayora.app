#!/bin/bash

set -e

PORT=3000
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo " BAYORA SERVER MANAGER"
echo "========================================"

cd "$PROJECT_DIR"

echo "[1/4] Mengecek proses di port $PORT..."

PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)

if [ -n "$PIDS" ]; then
    echo "Ditemukan proses aktif di port $PORT:"
    echo "$PIDS"

    echo "[2/4] Menghentikan proses BAYORA lama..."

    for PID in $PIDS; do
        kill "$PID" 2>/dev/null || true
    done

    sleep 1

    REMAINING=$(lsof -ti :"$PORT" 2>/dev/null || true)

    if [ -n "$REMAINING" ]; then
        echo "Proses masih aktif, menghentikan dengan paksa..."

        for PID in $REMAINING; do
            kill -9 "$PID" 2>/dev/null || true
        done

        sleep 1
    fi
else
    echo "Tidak ada server lama di port $PORT."
fi

echo "[3/4] Memeriksa port $PORT..."

if lsof -ti :"$PORT" >/dev/null 2>&1; then
    echo "ERROR: Port $PORT masih digunakan."
    exit 1
fi

echo "Port $PORT tersedia."

echo "[4/4] Menjalankan server terbaru..."
echo ""

exec node server/server.js
