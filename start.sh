#!/bin/bash
# 快速启动脚本

echo "正在启动硅基流动API代理服务..."

# 检查Docker是否安装
if command -v docker &> /dev/null; then
    echo "使用Docker启动..."
    docker-compose up -d
    echo "服务已启动，访问 http://localhost:3838"
else
    echo "Docker未安装，使用Node.js直接启动..."
    if [ ! -d "node_modules" ]; then
        echo "正在安装依赖..."
        npm install
    fi
    npm start
fi

