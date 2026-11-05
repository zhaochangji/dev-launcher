#!/bin/bash
# 打一个发给同事的 zip（只含运行所需文件，自动清理 .DS_Store / dist）
cd "$(dirname "$0")"
OUT="$PWD/dist"
ZIP="$OUT/dev-launcher.zip"
TMP=/tmp/dev-launcher-dist.zip
STAGE=/tmp/dev-launcher-stage

rm -rf "$OUT" "$TMP" "$STAGE"
mkdir -p "$OUT" "$STAGE/dev-launcher"

# 只拷必要内容（不拷 dist、.DS_Store、日志）
for f in server.js projects.json README.md 分发说明.md 启动项目面板.command 启动项目面板.app public; do
  [ -e "$PWD/$f" ] && cp -R "$PWD/$f" "$STAGE/dev-launcher/"
done

# 用 ditto 打包，保留 .app 的签名与扩展属性
ditto -c -k --sequesterRsrc --keepParent "$STAGE/dev-launcher" "$TMP" || { echo "打包失败"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; }
mv "$TMP" "$ZIP"
rm -rf "$STAGE"

echo "✅ 已生成：$ZIP"
echo
echo "发给同事时附上这句话："
echo "  「解压后先看『分发说明.md』；最省事的做法是在终端执行："
echo "    xattr -dr com.apple.quarantine <解压后的 dev-launcher 目录>"
echo "    然后双击『启动项目面板.app』」"
echo
echo "提示：用团队 git 仓库分发（git clone）不会产生隔离标记，同事可直接双击 .app。"
open "$OUT" || true
sleep 3
