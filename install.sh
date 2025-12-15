#!/bin/bash

# SiliconFlow Proxy 生产环境一键部署脚本
# 支持远程执行: curl -fsSL https://raw.githubusercontent.com/laolaoshiren/siliconflowProxy/main/install.sh | bash

set -euo pipefail

# 错误处理
trap 'print_error "脚本执行出错，行号: $LINENO"' ERR

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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

print_title() {
    echo -e "${CYAN}$1${NC}"
}

# 打印分隔线
print_separator() {
    echo "=================================================="
}

# 生成随机密码
generate_password() {
    if command -v openssl &> /dev/null; then
        openssl rand -base64 12 | tr -d "=+/" | cut -c1-16
    else
        cat /dev/urandom 2>/dev/null | tr -dc 'a-zA-Z0-9' | fold -w 16 2>/dev/null | head -n 1 || echo "SiliconFlow$(date +%s | tail -c 8)"
    fi
}

# 检查命令是否存在
check_command() {
    command -v "$1" &> /dev/null
}

# 等待服务就绪
wait_for_service() {
    local url=$1
    local max_attempts=30
    local attempt=0
    
    if ! check_command curl; then
        return 1
    fi
    
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

# 获取主机IP
get_host_ip() {
    local ip=""
    
    # 方法1: hostname -I
    if command -v hostname &> /dev/null; then
        ip=$(hostname -I 2>/dev/null | awk '{print $1}' 2>/dev/null || echo "")
    fi
    
    # 方法2: ip route
    if [ -z "$ip" ] || [ "$ip" = "localhost" ]; then
        if command -v ip &> /dev/null; then
            ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "")
        fi
    fi
    
    # 方法3: curl 获取公网IP
    if [ -z "$ip" ] || [ "$ip" = "localhost" ]; then
        if check_command curl; then
            ip=$(curl -s --max-time 2 ifconfig.me 2>/dev/null || echo "")
        fi
    fi
    
    echo "${ip:-localhost}"
}

# 安装 Docker（如果需要）
install_docker() {
    print_info "检测到 Docker 未安装，开始安装..."
    
    if [ "$EUID" -ne 0 ]; then
        print_error "需要 root 权限来安装 Docker"
        print_info "请运行: sudo bash -c \"\$(curl -fsSL https://get.docker.com)\""
        exit 1
    fi
    
    if check_command curl; then
        curl -fsSL https://get.docker.com | sh
    else
        print_error "需要 curl 来下载 Docker 安装脚本"
        exit 1
    fi
    
    # 启动 Docker 服务
    if command -v systemctl &> /dev/null; then
        systemctl start docker
        systemctl enable docker
    fi
    
    print_success "Docker 安装完成"
}

# 检查并安装 Docker Compose
check_docker_compose() {
    if docker compose version &> /dev/null 2>&1; then
        DOCKER_COMPOSE_CMD="docker compose"
        return 0
    elif check_command docker-compose; then
        DOCKER_COMPOSE_CMD="docker-compose"
        return 0
    else
        print_warning "Docker Compose 未安装，尝试安装..."
        
        if [ "$EUID" -ne 0 ]; then
            print_error "需要 root 权限来安装 Docker Compose"
            exit 1
        fi
        
        # 安装 docker-compose
        if check_command curl; then
            curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
            chmod +x /usr/local/bin/docker-compose
            DOCKER_COMPOSE_CMD="docker-compose"
            print_success "Docker Compose 安装完成"
            return 0
        else
            print_error "需要 curl 来下载 Docker Compose"
            exit 1
        fi
    fi
}

# 创建 docker-compose 配置文件
create_docker_compose() {
    local port=${1:-3838}
    local admin_password=$2
    local compose_file="docker-compose.prod.yml"
    
    print_info "创建 Docker Compose 配置文件..."
    
    cat > "$compose_file" <<EOF
version: '3.8'

services:
  siliconflow-proxy:
    image: ghcr.io/laolaoshiren/siliconflowproxy:latest
    container_name: siliconflow-proxy
    ports:
      - "${port}:3838"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    environment:
      - PORT=3838
      - NODE_ENV=production
      - ADMIN_PASSWORD=${admin_password}
      - AUTO_QUERY_BALANCE_AFTER_CALLS=10
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3838/api/proxy/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
EOF
    
    print_success "配置文件已创建: $compose_file"
}

# 主函数
main() {
    # 清屏（如果支持）
    clear 2>/dev/null || true
    print_separator
    print_title "  SiliconFlow Proxy 生产环境一键部署"
    print_separator
    echo ""
    
    # 1. 检查并安装 Docker
    print_info "检查 Docker 环境..."
    if ! check_command docker; then
        install_docker
    else
        print_success "Docker 已安装: $(docker --version | cut -d' ' -f3 | cut -d',' -f1)"
    fi
    
    # 检查 Docker 服务
    if ! docker info &> /dev/null; then
        print_warning "Docker 服务未运行，尝试启动..."
        if command -v systemctl &> /dev/null && [ "$EUID" -eq 0 ]; then
            systemctl start docker
            sleep 2
        fi
        
        if ! docker info &> /dev/null; then
            print_error "Docker 服务无法启动，请手动启动: sudo systemctl start docker"
            exit 1
        fi
    fi
    print_success "Docker 服务运行正常"
    
    # 2. 检查并安装 Docker Compose
    print_info "检查 Docker Compose..."
    check_docker_compose
    print_success "Docker Compose 可用"
    
    # 3. 创建工作目录
    WORK_DIR="${SILICONFLOW_PROXY_DIR:-$(pwd)}"
    if [ ! -d "$WORK_DIR" ]; then
        mkdir -p "$WORK_DIR" || {
            print_error "无法创建工作目录: $WORK_DIR"
            exit 1
        }
    fi
    cd "$WORK_DIR" || {
        print_error "无法切换到工作目录: $WORK_DIR"
        exit 1
    }
    print_info "工作目录: $WORK_DIR"
    
    # 4. 创建数据目录
    print_info "创建必要的目录..."
    mkdir -p data
    print_success "目录创建完成"
    
    # 5. 处理端口配置
    PORT=${PORT:-3838}
    print_info "服务端口: $PORT"
    
    # 6. 处理管理员密码
    print_info "处理管理员密码..."
    
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
    USE_EXISTING_PASSWORD=false
    
    # 检查是否已有 .env 文件
    if [ -f .env ] && grep -q "ADMIN_PASSWORD=" .env; then
        EXISTING_PASSWORD=$(grep "ADMIN_PASSWORD=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'" | xargs)
        if [ -n "$EXISTING_PASSWORD" ]; then
            ADMIN_PASSWORD="$EXISTING_PASSWORD"
            USE_EXISTING_PASSWORD=true
            print_success "使用现有管理员密码（从 .env 文件）"
        fi
    fi
    
    # 如果环境变量中有密码，使用环境变量
    if [ -z "$ADMIN_PASSWORD" ] && [ -n "${ADMIN_PASSWORD_ENV:-}" ]; then
        ADMIN_PASSWORD="$ADMIN_PASSWORD_ENV"
        USE_EXISTING_PASSWORD=true
        print_success "使用环境变量中的管理员密码"
    fi
    
    # 使用默认密码（如果未设置）
    if [ -z "$ADMIN_PASSWORD" ]; then
        ADMIN_PASSWORD="admin"
        print_success "使用默认管理员密码: admin"
    fi
    
    # 7. 创建或更新 docker-compose 配置
    if [ ! -f docker-compose.prod.yml ]; then
        create_docker_compose "$PORT" "$ADMIN_PASSWORD"
    else
        print_info "检测到现有的 docker-compose.prod.yml，更新配置..."
        
        # 更新端口配置（如果使用的是旧的默认值 3000）
        if grep -q "\${PORT:-3000}" docker-compose.prod.yml 2>/dev/null; then
            print_info "更新端口配置为默认值 3838..."
            sed -i 's/\${PORT:-3000}/\${PORT:-3838}/g' docker-compose.prod.yml
        fi
        
        # 更新环境变量中的端口（如果使用的是旧的默认值 3000）
        if grep -q "PORT=\${PORT:-3000}" docker-compose.prod.yml 2>/dev/null; then
            print_info "更新环境变量端口配置..."
            sed -i 's/PORT=\${PORT:-3000}/PORT=3838/g' docker-compose.prod.yml
        fi
        
        # 更新端口映射（如果使用的是旧的 3000 内部端口）
        if grep -q ":3000" docker-compose.prod.yml 2>/dev/null && ! grep -q ":3838" docker-compose.prod.yml 2>/dev/null; then
            print_info "更新端口映射配置..."
            sed -i 's/:3000/:3838/g' docker-compose.prod.yml
        fi
        
        # 更新管理员密码（如果配置文件中没有设置或需要更新）
        if ! grep -q "ADMIN_PASSWORD=${ADMIN_PASSWORD}" docker-compose.prod.yml 2>/dev/null; then
            # 如果配置文件中是空的 ADMIN_PASSWORD，则更新它
            if grep -q "ADMIN_PASSWORD=\${ADMIN_PASSWORD:-}" docker-compose.prod.yml 2>/dev/null; then
                print_info "更新管理员密码配置..."
                sed -i "s/ADMIN_PASSWORD=\${ADMIN_PASSWORD:-}/ADMIN_PASSWORD=${ADMIN_PASSWORD}/g" docker-compose.prod.yml
            elif grep -q "ADMIN_PASSWORD=" docker-compose.prod.yml 2>/dev/null; then
                print_info "更新管理员密码配置..."
                sed -i "s/ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${ADMIN_PASSWORD}/g" docker-compose.prod.yml
            fi
        fi
        
        print_success "配置文件已更新"
    fi
    
    # 8. 停止并删除旧容器（使用 docker-compose 确保完全清理）
    print_info "检查并清理旧容器..."
    if docker ps -a --format '{{.Names}}' | grep -q "^siliconflow-proxy$"; then
        print_warning "发现已存在的容器，正在停止并删除..."
        # 使用 docker-compose down 确保完全清理
        $DOCKER_COMPOSE_CMD -f docker-compose.prod.yml down 2>/dev/null || true
        # 备用方法：直接使用 docker 命令
        docker stop siliconflow-proxy 2>/dev/null || true
        docker rm siliconflow-proxy 2>/dev/null || true
        print_success "旧容器已清理"
    fi
    
    # 9. 拉取最新镜像
    print_info "拉取最新 Docker 镜像..."
    if docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest; then
        print_success "镜像拉取成功"
    else
        print_warning "镜像拉取失败，将尝试使用本地镜像或重新拉取"
        sleep 2
        docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest || {
            print_error "镜像拉取失败，请检查网络连接"
            exit 1
        }
    fi
    
    # 10. 启动服务
    print_info "启动服务..."
    if $DOCKER_COMPOSE_CMD -f docker-compose.prod.yml up -d; then
        print_success "服务启动成功"
    else
        print_error "服务启动失败"
        print_info "请检查日志: $DOCKER_COMPOSE_CMD -f docker-compose.prod.yml logs"
        exit 1
    fi
    
    # 11. 等待服务就绪
    print_info "等待服务就绪..."
    SERVICE_URL="http://localhost:${PORT}/api/proxy/health"
    
    if wait_for_service "$SERVICE_URL"; then
        print_success "服务已就绪"
    else
        print_warning "服务启动超时，但容器可能仍在运行中"
    fi
    
    # 12. 获取服务信息
    echo ""
    print_separator
    print_title "  部署完成！"
    print_separator
    echo ""
    
    # 获取容器状态
    CONTAINER_STATUS=$(docker ps --filter "name=siliconflow-proxy" --format "{{.Status}}" 2>/dev/null || echo "未知")
    
    # 获取实际访问地址
    HOST_IP=$(get_host_ip)
    
    # 显示重要信息
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  重要信息 - 请妥善保管！${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BLUE}📌 服务访问地址：${NC}"
    echo -e "   本地访问: ${GREEN}http://localhost:${PORT}${NC}"
    if [ "$HOST_IP" != "localhost" ]; then
        echo -e "   网络访问: ${GREEN}http://${HOST_IP}:${PORT}${NC}"
    fi
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
    echo -e "   ${YELLOW}${WORK_DIR}/data${NC}"
    echo ""
    echo -e "${BLUE}🔄 更新服务：${NC}"
    echo -e "   ${YELLOW}curl -fsSL https://raw.githubusercontent.com/laolaoshiren/siliconflowProxy/main/install.sh | bash${NC}"
    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo ""
    
    # 保存密码到文件（仅在新生成密码时）
    if [ "$USE_EXISTING_PASSWORD" = false ]; then
        PASSWORD_FILE="${WORK_DIR}/.deploy_password.txt"
        echo "$ADMIN_PASSWORD" > "$PASSWORD_FILE" 2>/dev/null || true
        chmod 600 "$PASSWORD_FILE" 2>/dev/null || true
        print_warning "管理员密码已保存到: ${PASSWORD_FILE} (权限: 600)"
        print_warning "请妥善保管该文件，建议部署完成后删除"
    fi
    
    # 保存到 .env 文件
    if [ ! -f .env ] || ! grep -q "ADMIN_PASSWORD=" .env; then
        cat >> .env <<EOF
# SiliconFlow Proxy 环境配置
PORT=${PORT}
NODE_ENV=production
ADMIN_PASSWORD=${ADMIN_PASSWORD}
AUTO_QUERY_BALANCE_AFTER_CALLS=10
EOF
        print_info "配置已保存到 .env 文件"
    fi
    
    # 显示健康检查
    echo ""
    print_info "执行健康检查..."
    HEALTH_URL="http://localhost:${PORT}/api/proxy/health"
    if check_command curl; then
        if curl -s -f --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
            print_success "健康检查通过 ✓"
        else
            print_warning "健康检查失败，服务可能仍在启动中"
            print_info "请稍后访问服务或查看日志确认"
        fi
    else
        print_warning "curl 未安装，跳过健康检查"
    fi
    
    echo ""
    print_success "部署完成！"
    echo ""
    print_info "提示：可以使用以下命令查看实时日志："
    echo -e "   ${YELLOW}docker logs -f siliconflow-proxy${NC}"
    echo ""
}

# 执行主函数
main "$@"

