#!/bin/bash
# 双击启动「本地项目启动器」面板（已在运行则直接打开页面；端口被占自动避让）
cd "$(dirname "$0")"
PORT_FILE="$HOME/.dev-launcher/port"

try_open_running() {
  for p in $(cat "$PORT_FILE" 2>/dev/null) 7877 7878 7879 7880 7881 7882; do
    [ -z "$p" ] && continue
    if curl -s -m 1 "http://127.0.0.1:$p/api/ping" >/dev/null 2>&1; then
      open "http://127.0.0.1:$p" && return 0
    fi
  done
  return 1
}

if try_open_running; then
  echo "面板已在运行，已打开页面。"
  sleep 1
  exit 0
fi

echo "启动面板服务…"
mkdir -p /tmp/dev-launcher
nohup node server.js > /tmp/dev-launcher/panel-server.log 2>&1 &

for i in $(seq 1 14); do
  P=$(cat "$PORT_FILE" 2>/dev/null)
  if [ -n "$P" ] && curl -s -m 1 "http://127.0.0.1:$P/api/ping" >/dev/null 2>&1; then
    open "http://127.0.0.1:$P"
    echo
    echo "✅ 面板已启动：http://127.0.0.1:$P"
    echo "   本窗口可以关闭；面板常驻后台。"
    sleep 2
    exit 0
  fi
  sleep 0.5
done

echo "❌ 面板启动失败，日志：/tmp/dev-launcher/panel-server.log（是否安装了 Node？）"
read -n 1 -s -r -p "按任意键关闭…"
