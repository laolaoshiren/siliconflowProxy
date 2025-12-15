#!/bin/bash

# 清理脚本：停止并删除所有相关容器和网络

echo "正在清理 SiliconFlow Proxy 相关资源..."

# 停止并删除容器
if docker ps -a --format '{{.Names}}' | grep -q "^siliconflow-proxy$"; then
    echo "停止并删除容器..."
    docker stop siliconflow-proxy 2>/dev/null || true
    docker rm siliconflow-proxy 2>/dev/null || true
    echo "容器已清理"
fi

# 清理 docker-compose 资源
if [ -f docker-compose.prod.yml ]; then
    echo "清理 docker-compose 资源..."
    docker compose -f docker-compose.prod.yml down 2>/dev/null || docker-compose -f docker-compose.prod.yml down 2>/dev/null || true
fi

# 清理可能残留的网络
docker network prune -f 2>/dev/null || true

echo "清理完成！"

