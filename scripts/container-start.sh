#!/bin/sh
# OpenPrintShare 容器启动脚本：先起 ops-host（REST :3001 / RT :3002），再起 Next.js(:3000)
set -e

cd /app/mini-services/ops-host
bun index.ts &
HOST_PID=$!
echo "[container] ops-host started (pid=$HOST_PID)"

cd /app
node server.js &
WEB_PID=$!
echo "[container] web console started (pid=$WEB_PID)"

# 转发信号，任一进程退出即结束容器
trap 'kill $HOST_PID $WEB_PID 2>/dev/null; exit 0' TERM INT
wait -n $HOST_PID $WEB_PID
exit $?
