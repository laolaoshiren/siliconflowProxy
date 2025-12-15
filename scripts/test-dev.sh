#!/bin/bash

# 测试开发环境脚本

cd "$(dirname "$0")/.."

echo "=== 测试 npm run dev 改进 ==="
echo ""

# 检查脚本是否存在
if [ ! -f "scripts/dev.js" ]; then
    echo "❌ scripts/dev.js 不存在"
    exit 1
fi

echo "✓ scripts/dev.js 存在"

# 检查package.json配置
if grep -q '"dev": "node scripts/dev.js"' package.json; then
    echo "✓ package.json 配置正确"
else
    echo "❌ package.json 配置错误"
    exit 1
fi

# 检查脚本语法
if node -c scripts/dev.js 2>/dev/null; then
    echo "✓ 脚本语法正确"
else
    echo "❌ 脚本语法错误"
    exit 1
fi

echo ""
echo "✅ 所有检查通过！"
echo ""
echo "使用方法:"
echo "  npm run dev"
echo ""
echo "功能特性:"
echo "  - 自动清理旧进程"
echo "  - 使用最新代码启动"
echo "  - 支持代码热重载（nodemon）"

