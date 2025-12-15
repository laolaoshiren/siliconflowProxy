#!/bin/bash

# SiliconFlow Proxy 生产环境一键部署脚本
# 功能：自动检查环境、生成密码、部署服务并显示必要信息

# 注意：不使用 set -e，以便更好地处理错误

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}[信息]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[成功]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[警告]${NC} $1"
}

print_error() {
    echo -e "${RED}[错误]${NC} $1"
}

# 打印分隔线
print_separator() {
    echo "=================================================="
}

# 生成随机密码
generate_password() {
    # 优先使用 openssl，如果不可用则使用 /dev/urandom
    if command -v openssl &> /dev/null; then
        openssl rand -base64 12 | tr -d "=+/" | cut -c1-16
    else
        # 备用方法：使用 /dev/urandom
        cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 16 | head -n 1
    fi
}

# 检查命令是否存在
check_command() {
    if ! command -v $1 &> /dev/null; then
        return 1
    fi
    return 0
}

# 等待服务就绪
wait_for_service() {
    local url=$1
    local max_attempts=30
    local attempt=0
    
    # 检查 curl 是否可用
    if ! command -v curl &> /dev/null; then
        print_warning "curl 未安装，跳过服务就绪检查"
        return 1
    fi
    
    print_info "等待服务启动..."
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f --max-time 2 "$url" > /dev/null 2>&1; then
            return 0
        fi
        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done
    
    echo ""
    return 1
}

# 主函数
main() {
    print_separator
    echo -e "${GREEN}SiliconFlow Proxy 生产环境一键部署脚本${NC}"
    print_separator
    echo ""
    
    # 1. 检查 Docker 环境
    print_info "检查 Docker 环境..."
    if ! check_command docker; then
        print_error "Docker 未安装，请先安装 Docker"
        echo "安装命令：curl -fsSL https://get.docker.com | sh"
        exit 1
    fi
    print_success "Docker 已安装: $(docker --version)"
    
    if ! check_command docker-compose && ! docker compose version &> /dev/null; then
        print_error "Docker Compose 未安装，请先安装 Docker Compose"
        exit 1
    fi
    
    # 检查 docker compose 命令（新版本）
    if docker compose version &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker compose"
        print_success "Docker Compose 已安装: $(docker compose version | head -n1)"
    else
        DOCKER_COMPOSE_CMD="docker-compose"
        print_success "Docker Compose 已安装: $(docker-compose --version)"
    fi
    
    # 2. 检查 Docker 服务是否运行
    if ! docker info &> /dev/null; then
        print_error "Docker 服务未运行，请启动 Docker 服务"
        echo "启动命令：sudo systemctl start docker"
        exit 1
    fi
    print_success "Docker 服务运行正常"
    
    # 3. 创建必要的目录
    print_info "创建必要的目录..."
    mkdir -p data
    print_success "目录创建完成"
    
    # 4. 处理管理员密码
    print_info "处理管理员密码..."
    
    # 检查是否已有 .env 文件
    if [ -f .env ]; then
        # 从 .env 文件读取现有密码
        if grep -q "ADMIN_PASSWORD=" .env; then
            ADMIN_PASSWORD=$(grep "ADMIN_PASSWORD=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
            if [ -n "$ADMIN_PASSWORD" ]; then
                print_success "使用现有管理员密码（从 .env 文件）"
                USE_EXISTING_PASSWORD=true
            else
                print_warning ".env 文件中 ADMIN_PASSWORD 为空，将生成新密码"
                ADMIN_PASSWORD=$(generate_password)
                USE_EXISTING_PASSWORD=false
            fi
        else
            print_warning ".env 文件存在但未设置 ADMIN_PASSWORD，将生成新密码"
            ADMIN_PASSWORD=$(generate_password)
            USE_EXISTING_PASSWORD=false
        fi
    else
        # 检查环境变量
        if [ -n "$ADMIN_PASSWORD" ]; then
            print_success "使用环境变量中的管理员密码"
            USE_EXISTING_PASSWORD=true
        else
            # 生成新密码
            ADMIN_PASSWORD=$(generate_password)
            print_success "已生成新的管理员密码"
            USE_EXISTING_PASSWORD=false
        fi
    fi
    
    # 5. 处理端口配置
    PORT=${PORT:-3838}
    print_info "服务端口: ${PORT}"
    
    # 6. 创建或更新 .env 文件
    if [ "$USE_EXISTING_PASSWORD" = false ]; then
        print_info "创建 .env 文件..."
        cat > .env <<EOF
# SiliconFlow Proxy 环境配置
PORT=${PORT}
NODE_ENV=production
ADMIN_PASSWORD=${ADMIN_PASSWORD}
AUTO_QUERY_BALANCE_AFTER_CALLS=10
EOF
        print_success ".env 文件已创建"
    fi
    
    # 7. 停止并删除旧容器（如果存在）
    print_info "检查并清理旧容器..."
    if docker ps -a --format '{{.Names}}' | grep -q "^siliconflow-proxy$"; then
        print_warning "发现已存在的容器，正在停止并删除..."
        docker stop siliconflow-proxy 2>/dev/null || true
        docker rm siliconflow-proxy 2>/dev/null || true
        print_success "旧容器已清理"
    fi
    
    # 8. 拉取最新镜像（如果使用生产配置）
    if [ -f docker-compose.prod.yml ]; then
        print_info "拉取最新 Docker 镜像..."
        docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest || print_warning "镜像拉取失败，将使用本地镜像"
    fi
    
    # 9. 启动服务
    print_info "启动服务..."
    
    # 选择使用哪个 docker-compose 文件
    if [ -f docker-compose.prod.yml ]; then
        COMPOSE_FILE="docker-compose.prod.yml"
        print_info "使用生产环境配置 (docker-compose.prod.yml)"
    else
        COMPOSE_FILE="docker-compose.yml"
        print_info "使用开发环境配置 (docker-compose.yml)"
    fi
    
    # 启动容器
    if $DOCKER_COMPOSE_CMD -f $COMPOSE_FILE up -d; then
        print_success "服务启动成功"
    else
        print_error "服务启动失败"
        print_info "请检查日志: $DOCKER_COMPOSE_CMD -f $COMPOSE_FILE logs"
        exit 1
    fi
    
    # 10. 等待服务就绪
    print_info "等待服务就绪..."
    SERVICE_URL="http://localhost:${PORT}/api/proxy/health"
    
    if wait_for_service "$SERVICE_URL"; then
        print_success "服务已就绪"
    else
        print_warning "服务启动超时，但容器可能仍在运行中"
        print_info "请稍后手动检查服务状态"
    fi
    
    # 11. 获取服务信息
    echo ""
    print_separator
    echo -e "${GREEN}部署完成！${NC}"
    print_separator
    echo ""
    
    # 获取容器状态
    CONTAINER_STATUS=$(docker ps --filter "name=siliconflow-proxy" --format "{{.Status}}" 2>/dev/null || echo "未知")
    
    # 获取实际访问地址
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' 2>/dev/null || echo "")
    if [ -z "$HOST_IP" ] || [ "$HOST_IP" = "localhost" ]; then
        # 尝试从网络接口获取
        HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "")
        if [ -z "$HOST_IP" ]; then
            # 最后尝试使用 curl 获取公网 IP（如果可用）
            if command -v curl &> /dev/null; then
                HOST_IP=$(curl -s --max-time 2 ifconfig.me 2>/dev/null || echo "localhost")
            else
                HOST_IP="localhost"
            fi
        fi
    fi
    
    # 显示重要信息
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  重要信息 - 请妥善保管！${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BLUE}📌 服务访问地址：${NC}"
    echo -e "   本地访问: ${GREEN}http://localhost:${PORT}${NC}"
    echo -e "   网络访问: ${GREEN}http://${HOST_IP}:${PORT}${NC}"
    echo ""
    echo -e "${BLUE}🔑 管理员密码：${NC}"
    echo -e "   ${RED}${ADMIN_PASSWORD}${NC}"
    echo ""
    echo -e "${BLUE}📊 容器状态：${NC}"
    echo -e "   ${CONTAINER_STATUS}"
    echo ""
    echo -e "${BLUE}📝 管理命令：${NC}"
    echo -e "   查看日志: ${YELLOW}docker logs -f siliconflow-proxy${NC}"
    echo -e "   停止服务: ${YELLOW}docker stop siliconflow-proxy${NC}"
    echo -e "   启动服务: ${YELLOW}docker start siliconflow-proxy${NC}"
    echo -e "   重启服务: ${YELLOW}docker restart siliconflow-proxy${NC}"
    echo -e "   删除服务: ${YELLOW}docker stop siliconflow-proxy && docker rm siliconflow-proxy${NC}"
    echo ""
    echo -e "${BLUE}📁 数据目录：${NC}"
    echo -e "   ${YELLOW}$(pwd)/data${NC}"
    echo ""
    echo -e "${BLUE}🔄 更新服务：${NC}"
    if [ -f docker-compose.prod.yml ]; then
        echo -e "   ${YELLOW}docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest${NC}"
        echo -e "   ${YELLOW}$DOCKER_COMPOSE_CMD -f docker-compose.prod.yml up -d${NC}"
    else
        echo -e "   ${YELLOW}$DOCKER_COMPOSE_CMD up -d --build${NC}"
    fi
    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo ""
    
    # 保存密码到文件（仅在新生成密码时）
    PASSWORD_FILE=".deploy_password.txt"
    if [ "$USE_EXISTING_PASSWORD" = false ]; then
        echo "$ADMIN_PASSWORD" > "$PASSWORD_FILE" 2>/dev/null || true
        chmod 600 "$PASSWORD_FILE" 2>/dev/null || true
        print_warning "管理员密码已保存到: ${PASSWORD_FILE} (权限: 600)"
        print_warning "请妥善保管该文件，建议部署完成后删除"
    fi
    
    # 显示健康检查
    echo ""
    print_info "执行健康检查..."
    HEALTH_URL="http://localhost:${PORT}/api/proxy/health"
    if command -v curl &> /dev/null; then
        if curl -s -f --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
            print_success "健康检查通过 ✓"
        else
            print_warning "健康检查失败，服务可能仍在启动中"
            print_info "请稍后访问服务或查看日志确认"
        fi
    else
        print_warning "curl 未安装，跳过健康检查"
        print_info "请手动访问服务确认是否正常运行"
    fi
    
    echo ""
    print_success "部署脚本执行完成！"
    echo ""
}

# 执行主函数
main "$@"

