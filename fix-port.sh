#!/bin/bash

# 快速修复端口配置脚本

set -e

COMPOSE_FILE="${1:-docker-compose.prod.yml}"

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "错误: 文件 $COMPOSE_FILE 不存在"
    exit 1
fi

echo "正在修复 $COMPOSE_FILE 中的端口配置..."

# 备份原文件
cp "$COMPOSE_FILE" "${COMPOSE_FILE}.bak"
echo "已备份原文件到 ${COMPOSE_FILE}.bak"

# 更新所有端口相关配置
sed -i 's/\${PORT:-3000}:3000/\${PORT:-3838}:3838/g' "$COMPOSE_FILE"
sed -i 's/\${PORT:-3000}:3838/\${PORT:-3838}:3838/g' "$COMPOSE_FILE"
sed -i 's/\${PORT:-3838}:3000/\${PORT:-3838}:3838/g' "$COMPOSE_FILE"
sed -i 's|"\(.*\):3000"|"\1:3838"|g' "$COMPOSE_FILE"
sed -i "s|'\(.*\):3000'|'\1:3838'|g" "$COMPOSE_FILE"
sed -i 's/PORT=\${PORT:-3000}/PORT=3838/g' "$COMPOSE_FILE"
sed -i 's/- PORT=3000/- PORT=3838/g' "$COMPOSE_FILE"
sed -i 's/- PORT=${PORT:-3000}/- PORT=3838/g' "$COMPOSE_FILE"
sed -i 's/localhost:3000/localhost:3838/g' "$COMPOSE_FILE"

echo "✓ 端口配置已修复"
echo ""
echo "修复后的配置:"
grep -E "ports:|PORT=|localhost:" "$COMPOSE_FILE" || true

