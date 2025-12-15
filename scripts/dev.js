#!/usr/bin/env node

/**
 * 开发环境启动脚本
 * 功能：自动清理旧进程，确保使用最新代码启动
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// 加载 .env 文件（如果存在）
require('dotenv').config();

// 端口配置优先级：环境变量 > .env 文件 > 默认值
const PORT = process.env.PORT || 3838;
const PID_FILE = path.join(__dirname, '..', '.dev.pid');

// 清理旧进程
function cleanupOldProcess() {
  return new Promise((resolve) => {
    console.log('🔍 检查并清理旧进程...');
    
    // 读取PID文件
    let oldPid = null;
    if (fs.existsSync(PID_FILE)) {
      try {
        oldPid = fs.readFileSync(PID_FILE, 'utf8').trim();
      } catch (e) {
        // 忽略读取错误
      }
    }
    
    // 清理函数
    const cleanup = () => {
      const promises = [];
      
      // 1. 通过PID文件清理
      if (oldPid) {
        promises.push(new Promise((res) => {
          exec(`kill -9 ${oldPid} 2>/dev/null`, () => res());
        }));
      }
      
      // 2. 通过端口清理（更彻底）
      promises.push(new Promise((res) => {
        exec(`lsof -ti:${PORT} 2>/dev/null | xargs -r kill -9 2>/dev/null`, () => res());
      }));
      
      // 3. 通过进程名清理（更彻底）
      promises.push(new Promise((res) => {
        exec(`pkill -9 -f "node.*server.js" 2>/dev/null`, () => res());
      }));
      
      // 4. 清理nodemon进程
      promises.push(new Promise((res) => {
        exec(`pkill -9 -f nodemon 2>/dev/null`, () => res());
      }));
      
      Promise.all(promises).then(() => {
        // 等待进程完全退出，增加等待时间
        setTimeout(() => {
          // 再次检查端口是否释放
          exec(`lsof -ti:${PORT} 2>/dev/null`, (err) => {
            if (err) {
              console.log('✅ 旧进程清理完成');
              resolve();
            } else {
              // 如果端口仍被占用，再等待并强制清理
              console.log('⚠️  端口仍被占用，强制清理...');
              exec(`lsof -ti:${PORT} 2>/dev/null | xargs -r kill -9 2>/dev/null`, () => {
                setTimeout(() => {
                  console.log('✅ 旧进程清理完成');
                  resolve();
                }, 1000);
              });
            }
          });
        }, 2000);
      });
    };
    
    cleanup();
  });
}

// 启动开发服务器
function startDevServer() {
  return new Promise((resolve, reject) => {
    console.log('🚀 启动开发服务器...');
    console.log(`📌 端口: ${PORT}`);
    console.log(`🔑 管理员密码: ${process.env.ADMIN_PASSWORD || '未设置'}`);
    console.log('');
    
    // 使用 nodemon 启动
    const nodemon = spawn('npx', ['nodemon', 'server.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: PORT.toString()
      }
    });
    
    // 保存PID（使用nodemon的PID）
    const pid = nodemon.pid;
    try {
      fs.writeFileSync(PID_FILE, pid.toString());
    } catch (e) {
      console.warn('⚠️  无法写入PID文件:', e.message);
    }
    
    // 处理退出
    nodemon.on('exit', (code) => {
      // 清理PID文件
      if (fs.existsSync(PID_FILE)) {
        try {
          fs.unlinkSync(PID_FILE);
        } catch (e) {
          // 忽略错误
        }
      }
      
      if (code !== 0 && code !== null) {
        console.error(`\n❌ 进程异常退出，代码: ${code}`);
        reject(new Error(`Process exited with code ${code}`));
      } else {
        resolve();
      }
    });
    
    // 处理错误
    nodemon.on('error', (err) => {
      console.error('❌ 启动失败:', err);
      reject(err);
    });
    
    // 等待一下确保启动成功
    setTimeout(() => {
      if (!nodemon.killed) {
        console.log('✅ 开发服务器已启动');
        console.log(`🌐 访问地址: http://localhost:${PORT}`);
        console.log('📝 按 Ctrl+C 停止服务器\n');
        resolve();
      }
    }, 2000);
  });
}

// 主函数
async function main() {
  try {
    await cleanupOldProcess();
    await startDevServer();
  } catch (error) {
    console.error('❌ 启动失败:', error.message);
    process.exit(1);
  }
}

// 处理退出信号
process.on('SIGINT', () => {
  console.log('\n\n🛑 正在停止服务器...');
  cleanupOldProcess().then(() => {
    console.log('✅ 服务器已停止');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  cleanupOldProcess().then(() => {
    process.exit(0);
  });
});

main();




