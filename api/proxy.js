const express = require('express');
const axios = require('axios');
const db = require('../db');
const { 
  getCurrentApiKey, 
  switchToNextApiKey, 
  queryBalance, 
  markApiKeyStatus, 
  checkAndUpdateAvailability,
  isBusyError,
  getErrorMessage
} = require('../utils/apiManager');

const router = express.Router();

// 硅基流动API基础URL
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

// 重试配置
const MAX_RETRIES = 3; // 每个API key最多重试3次
const RETRY_DELAY = 30000; // 重试延迟30秒

// 定期清理过期的IP拉黑记录
setInterval(async () => {
  try {
    await db.clearExpiredBlocks();
  } catch (error) {
    console.error('清理过期IP拉黑记录失败:', error.message);
  }
}, 5 * 60 * 1000); // 每5分钟清理一次

// 转发聊天完成请求
router.post('/chat/completions', async (req, res) => {
  try {
    // 1. 检查IP是否被拉黑
    const blockInfo = await db.isIpBlocked();
    if (blockInfo) {
      const unblockTime = new Date(blockInfo.unblock_at);
      const now = new Date();
      const remainingMinutes = Math.ceil((unblockTime - now) / (1000 * 60));
      
      return res.status(503).json({
        error: {
          message: `服务器IP已被硅基流动拉黑，请等待 ${remainingMinutes} 分钟后重试`,
          type: 'ip_blocked',
          reason: blockInfo.reason || 'IP被硅基流动拉黑',
          unblock_at: blockInfo.unblock_at,
          remaining_minutes: remainingMinutes
        }
      });
    }

    // 2. 获取当前使用的API key
    let keyInfo = await getCurrentApiKey();
    if (!keyInfo) {
      return res.status(503).json({
        error: {
          message: '没有可用的API密钥',
          type: 'service_unavailable',
          reason: '所有API密钥都不可用或已欠费'
        }
      });
    }

    let apiKey = keyInfo.api_key;
    let apiKeyId = keyInfo.id;
    let maxKeyAttempts = 10; // 最多尝试10个不同的API key
    let keyAttempts = 0;
    let lastErrorKeyId = null; // 记录最后出错的key ID

    let requestSuccess = false; // 标记整个请求是否成功
    let lastError = null; // 记录最后一个错误

    while (keyAttempts < maxKeyAttempts && !requestSuccess) {
      // 对当前API key进行重试
      let retryCount = 0;
      let keySuccess = false; // 当前key是否成功

      while (retryCount <= MAX_RETRIES && !keySuccess) {
        try {
          // 检查是否是流式请求
          const isStreaming = req.body && req.body.stream === true;

          // 转发请求到硅基流动API
          const axiosConfig = {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 120000, // 120秒超时
            responseType: isStreaming ? 'stream' : 'json'
          };

          const response = await axios.post(
            `${SILICONFLOW_BASE_URL}/chat/completions`,
            req.body,
            axiosConfig
          );

          // 成功：更新API key状态，增加调用次数
          keySuccess = true;
          requestSuccess = true;
          await markApiKeyStatus(apiKeyId, 'active');
          await db.incrementCallCount(apiKeyId);
          await db.recordUsage(apiKeyId, true);

          // 如果之前这个key被标记为错误，现在成功了，恢复为正常
          const currentKeyInfo = await db.getApiKeyById(apiKeyId);
          if (currentKeyInfo && currentKeyInfo.status === 'error') {
            await markApiKeyStatus(apiKeyId, 'active');
            await db.updateApiKeyAvailability(apiKeyId, true);
            await require('../utils/apiManager').refreshApiKeys();
            console.log(`API Key ${apiKeyId} 已恢复为正常状态`);
          }

          // 检查是否需要自动查询余额
          const autoQueryThreshold = parseInt(process.env.AUTO_QUERY_BALANCE_AFTER_CALLS || '0');
          const shouldAutoQuery = autoQueryThreshold > 0;

          // 处理流式响应
          if (isStreaming && response.data) {
            const streamHeaders = {
              'Content-Type': response.headers['content-type'] || 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no'
            };

            if (response.headers['x-request-id']) {
              streamHeaders['X-Request-ID'] = response.headers['x-request-id'];
            }

            response.data.on('data', (chunk) => {
              if (!res.headersSent) {
                res.writeHead(200, streamHeaders);
              }
              res.write(chunk);
            });

            response.data.on('end', () => {
              res.end();
              if (shouldAutoQuery) {
                handleAutoQueryBalance(apiKeyId, autoQueryThreshold);
              }
            });

            response.data.on('error', (err) => {
              console.error(`流式响应错误 (API Key ${apiKeyId}):`, err.message);
              if (!res.headersSent) {
                res.status(500).json({
                  error: {
                    message: '流式响应错误',
                    type: 'stream_error',
                    reason: err.message
                  }
                });
              } else {
                res.end();
              }
            });

            req.on('close', () => {
              if (response.data && typeof response.data.destroy === 'function') {
                response.data.destroy();
              }
            });

            return; // 流式请求直接返回
          }

          // 非流式响应处理
          if (shouldAutoQuery) {
            handleAutoQueryBalance(apiKeyId, autoQueryThreshold);
          }

          return res.json(response.data);

        } catch (error) {
          lastError = error;
          console.error(`API Key ${apiKeyId} 请求失败 (重试 ${retryCount}/${MAX_RETRIES}):`, error.message);

          // 检查是否是busy错误（IP被拉黑）
          if (isBusyError(error)) {
            console.error('检测到busy错误，IP可能被硅基流动拉黑');
            await db.blockIp('检测到busy错误响应');
            
            const unblockTime = new Date(Date.now() + 30 * 60 * 1000);
            const remainingMinutes = 30;
            
            return res.status(503).json({
              error: {
                message: `服务器IP已被硅基流动拉黑，请等待 ${remainingMinutes} 分钟后重试`,
                type: 'ip_blocked',
                reason: '上游API返回busy错误，IP被拉黑',
                unblock_at: unblockTime.toISOString(),
                remaining_minutes: remainingMinutes
              }
            });
          }

          // 记录错误
          await db.recordUsage(apiKeyId, false, getErrorMessage(error));
          await markApiKeyStatus(apiKeyId, 'error', getErrorMessage(error));

          // 如果不是最后一次重试，等待后继续
          if (retryCount < MAX_RETRIES) {
            // 在重试前查询余额，判断是否因为欠费导致
            console.log(`API Key ${apiKeyId} 重试前查询余额...`);
            const balanceInfo = await queryBalance(apiKey);
            
            if (balanceInfo.success && balanceInfo.balance !== null) {
              await db.updateApiKeyBalance(apiKeyId, balanceInfo.balance);
              
              // 如果余额<1，标记为欠费并切换到下一个key
              if (balanceInfo.balance < 1) {
                console.log(`API Key ${apiKeyId} 余额不足 (¥${balanceInfo.balance.toFixed(2)})，切换到下一个key`);
                await markApiKeyStatus(apiKeyId, 'insufficient', '余额不足');
                await db.updateApiKeyAvailability(apiKeyId, false);
                await checkAndUpdateAvailability(apiKeyId);
                lastErrorKeyId = apiKeyId;
                break; // 跳出重试循环，切换到下一个key
              }
            }

            // 等待30秒后重试
            console.log(`等待 ${RETRY_DELAY / 1000} 秒后重试 API Key ${apiKeyId}...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            retryCount++;
          } else {
            // 重试次数用尽，标记为异常状态
            console.log(`API Key ${apiKeyId} 重试 ${MAX_RETRIES} 次后仍然失败，标记为异常状态`);
            await markApiKeyStatus(apiKeyId, 'error', getErrorMessage(error));
            await checkAndUpdateAvailability(apiKeyId);
            lastErrorKeyId = apiKeyId;
            break; // 跳出重试循环，切换到下一个key
          }
        }
      }

      // 如果当前key成功了，检查是否需要尝试恢复之前出错的key
      if (keySuccess && lastErrorKeyId && lastErrorKeyId !== apiKeyId) {
        // 检查之前出错的key的余额
        const errorKeyInfo = await db.getApiKeyById(lastErrorKeyId);
        if (errorKeyInfo) {
          const balanceInfo = await queryBalance(errorKeyInfo.api_key);
          if (balanceInfo.success && balanceInfo.balance !== null) {
            await db.updateApiKeyBalance(lastErrorKeyId, balanceInfo.balance);
            
            // 如果余额>=1，尝试恢复
            if (balanceInfo.balance >= 1) {
              console.log(`尝试恢复之前出错的 API Key ${lastErrorKeyId} (余额: ¥${balanceInfo.balance.toFixed(2)})`);
              await markApiKeyStatus(lastErrorKeyId, 'active');
              await db.updateApiKeyAvailability(lastErrorKeyId, true);
              await require('../utils/apiManager').refreshApiKeys();
            } else {
              // 余额仍然<1，标记为错误状态（避免下次重复尝试）
              console.log(`API Key ${lastErrorKeyId} 余额仍然不足，标记为错误状态`);
              await markApiKeyStatus(lastErrorKeyId, 'error', '余额不足');
              await db.updateApiKeyAvailability(lastErrorKeyId, false);
            }
          }
        }
      }

      // 如果当前key失败了，切换到下一个
      if (!keySuccess) {
        keyInfo = await switchToNextApiKey();
        if (!keyInfo) {
          return res.status(503).json({
            error: {
              message: '所有API密钥都不可用',
              type: 'service_unavailable',
              reason: '所有API密钥都已尝试，但都失败了'
            }
          });
        }
        apiKey = keyInfo.api_key;
        apiKeyId = keyInfo.id;
        keyAttempts++;
      }
      // 如果成功，requestSuccess已经是true，循环会自动退出
    }

    // 所有key都尝试过了，仍然失败
    if (!requestSuccess) {
      return res.status(503).json({
        error: {
          message: '所有API密钥都不可用，请稍后重试',
          type: 'service_unavailable',
          reason: lastError ? getErrorMessage(lastError) : '未知错误'
        }
      });
    }

  } catch (error) {
    console.error('代理错误:', error);
    return res.status(500).json({
      error: {
        message: '服务器内部错误',
        type: 'internal_error',
        reason: error.message
      }
    });
  }
});

// 处理自动查询余额的辅助函数
async function handleAutoQueryBalance(apiKeyId, autoQueryThreshold) {
  try {
    const keyInfo = await db.getApiKeyById(apiKeyId);
    if (keyInfo && keyInfo.call_count > 0) {
      const shouldQuery = keyInfo.call_count % autoQueryThreshold === 0;
      if (shouldQuery) {
        console.log(`API Key ${apiKeyId} 调用次数达到 ${keyInfo.call_count}，触发自动查询余额（阈值: ${autoQueryThreshold}）`);
        queryBalance(keyInfo.api_key).then(async (balanceInfo) => {
          if (balanceInfo.success && balanceInfo.balance !== null) {
            await db.updateApiKeyBalance(apiKeyId, balanceInfo.balance);
            
            if (balanceInfo.balance < 1) {
              await db.updateApiKeyAvailability(apiKeyId, false);
              await require('../utils/apiManager').refreshApiKeys();
            } else {
              const currentKey = await db.getApiKeyById(apiKeyId);
              if (currentKey && (currentKey.is_available === 0 || currentKey.is_available === null)) {
                await db.updateApiKeyAvailability(apiKeyId, true);
                await require('../utils/apiManager').refreshApiKeys();
              }
            }
            console.log(`API Key ${apiKeyId} 自动查询余额完成: ¥${balanceInfo.balance.toFixed(2)} (调用次数: ${keyInfo.call_count})`);
          }
        }).catch(err => {
          console.error(`API Key ${apiKeyId} 自动查询余额失败:`, err.message);
        });
      }
    }
  } catch (error) {
    console.error(`处理自动查询余额时出错 (API Key ${apiKeyId}):`, error.message);
  }
}

// 健康检查
router.get('/health', async (req, res) => {
  try {
    const blockInfo = await db.isIpBlocked();
    res.json({ 
      status: blockInfo ? 'blocked' : 'ok',
      ip_blocked: !!blockInfo,
      block_info: blockInfo
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      error: error.message 
    });
  }
});

module.exports = router;
