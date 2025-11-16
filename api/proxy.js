const express = require('express');
const axios = require('axios');
const db = require('../db');
const { getCurrentApiKey, switchToNextApiKey, checkBalance, markApiKeyStatus, checkAndUpdateAvailability, queryBalance } = require('../utils/apiManager');

const router = express.Router();

// 并发控制：确保30分钟内只有一个API调用
let isProcessing = false;
let lastApiCallTime = 0;
const MIN_INTERVAL = 30 * 60 * 1000; // 30分钟（毫秒）

// 硅基流动API基础URL
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

// 转发聊天完成请求
router.post('/chat/completions', async (req, res) => {
  // 检查并发限制
  const now = Date.now();
  if (isProcessing && (now - lastApiCallTime) < MIN_INTERVAL) {
    return res.status(429).json({
      error: {
        message: '请求过于频繁，请稍后再试（30分钟内只能有一个并发请求）',
        type: 'rate_limit_error'
      }
    });
  }

  isProcessing = true;
  lastApiCallTime = now;

  try {
    // 获取当前使用的API key（如果当前key无余额，会自动切换到下一个）
    let keyInfo = await getCurrentApiKey();
    if (!keyInfo) {
      isProcessing = false;
      return res.status(503).json({
        error: {
          message: '没有可用的API密钥',
          type: 'service_unavailable'
        }
      });
    }

    let apiKey = keyInfo.api_key;
    let apiKeyId = keyInfo.id;
    let maxAttempts = 10; // 最多尝试10个API key
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        // 转发请求到硅基流动API
        const response = await axios.post(
          `${SILICONFLOW_BASE_URL}/chat/completions`,
          req.body,
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 120000 // 120秒超时
          }
        );

        // 成功：更新API key状态，增加调用次数
        await markApiKeyStatus(apiKeyId, 'active');
        await db.incrementCallCount(apiKeyId);
        await db.recordUsage(apiKeyId, true);

        // 检查是否需要自动查询余额
        const autoQueryThreshold = parseInt(process.env.AUTO_QUERY_BALANCE_AFTER_CALLS || '0');
        if (autoQueryThreshold > 0) {
          const keyInfo = await db.getApiKeyById(apiKeyId);
          if (keyInfo && keyInfo.call_count > 0 && keyInfo.call_count % autoQueryThreshold === 0) {
            // 达到阈值，自动查询余额（异步执行，不阻塞响应）
            queryBalance(keyInfo.api_key).then(async (balanceInfo) => {
              if (balanceInfo.success && balanceInfo.balance !== null) {
                await db.updateApiKeyBalance(apiKeyId, balanceInfo.balance);
                
                // 如果余额<1，自动改为不可用状态
                if (balanceInfo.balance < 1) {
                  await db.updateApiKeyAvailability(apiKeyId, false);
                  await require('../utils/apiManager').refreshApiKeys();
                } else {
                  // 余额>=1，确保可用状态正确
                  const currentKey = await db.getApiKeyById(apiKeyId);
                  if (currentKey && (currentKey.is_available === 0 || currentKey.is_available === null)) {
                    await db.updateApiKeyAvailability(apiKeyId, true);
                    await require('../utils/apiManager').refreshApiKeys();
                  }
                }
                console.log(`API Key ${apiKeyId} 自动查询余额完成: ¥${balanceInfo.balance.toFixed(2)}`);
              }
            }).catch(err => {
              console.error(`API Key ${apiKeyId} 自动查询余额失败:`, err.message);
            });
          }
        }

        isProcessing = false;
        return res.json(response.data);
      } catch (error) {
        attempts++;
        console.error(`API Key ${apiKeyId} 请求失败:`, error.message);

        // 记录错误
        await db.recordUsage(apiKeyId, false, error.message);
        // 增加错误计数
        await markApiKeyStatus(apiKeyId, 'error', error.message);

        // 检查并更新可用状态（失败3次且余额<0.5才改为不可用）
        await checkAndUpdateAvailability(apiKeyId);

        // 检查是否是余额问题
        if (error.response) {
          const status = error.response.status;

          // 如果是401或403，可能是API key无效或余额不足
          if (status === 401 || status === 403) {
            // 尝试检查余额（注意：这个检查也会消耗一次API调用，但为了确保准确性）
            const hasBalance = await checkBalance(apiKey);
            if (!hasBalance) {
              // 没有余额，标记为欠费并切换到下一个
              await markApiKeyStatus(apiKeyId, 'insufficient', '余额不足');
              await db.updateApiKeyBalance(apiKeyId, 0);
              await checkAndUpdateAvailability(apiKeyId);
              keyInfo = await switchToNextApiKey();
              if (!keyInfo) {
                isProcessing = false;
                return res.status(503).json({
                  error: {
                    message: '所有API密钥都已欠费或不可用',
                    type: 'service_unavailable'
                  }
                });
              }
              apiKey = keyInfo.api_key;
              apiKeyId = keyInfo.id;
              continue; // 使用新的API key重试
            } else {
              // 有余额但请求失败，可能是临时错误，等待后重试同一个API key
              await new Promise(resolve => setTimeout(resolve, 2000));
              attempts--; // 不增加尝试次数，重试当前key
              continue;
            }
          } else if (status === 429) {
            // 速率限制，等待后重试同一个key
            await new Promise(resolve => setTimeout(resolve, 3000));
            attempts--;
            continue;
          } else {
            // 其他错误，等待后重试同一个key
            await new Promise(resolve => setTimeout(resolve, 2000));
            attempts--;
            continue;
          }
        } else {
          // 网络错误或其他错误，等待后重试同一个key
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts--;
          continue;
        }
      }
    }

    // 重试次数过多
    isProcessing = false;
    return res.status(500).json({
      error: {
        message: '请求失败，请稍后重试',
        type: 'internal_error'
      }
    });
  } catch (error) {
    isProcessing = false;
    console.error('代理错误:', error);
    return res.status(500).json({
      error: {
        message: '服务器内部错误',
        type: 'internal_error'
      }
    });
  }
});

// 健康检查
router.get('/health', (req, res) => {
  res.json({ status: 'ok', isProcessing, lastApiCallTime });
});

module.exports = router;

