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
  getErrorMessage,
  getCurrentApiKeyId,
  setCurrentApiKeyId
} = require('../utils/apiManager');
const {
  isProxyEnabled,
  getActiveProxy,
  tryProxyRequest,
  shouldUseProxy,
  createProxyAgent
} = require('../utils/proxyManager');

const router = express.Router();

// 硅基流动API基础URL
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

// 重试配置与超时
const MAX_RETRIES = 3; // 每个API key最多重试3次
const RETRY_DELAY = 30000; // 重试延迟30秒
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '240000'); // 上游请求超时（默认240秒）
const CLIENT_SOCKET_TIMEOUT_MS = parseInt(process.env.CLIENT_SOCKET_TIMEOUT_MS || '480000'); // 客户端连接/响应最大保持时间（默认480秒）

const RESPONSE_TYPE_LABEL = {
  stream: '流式',
  json: 'JSON'
};

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (req.ip) {
    return req.ip.replace('::ffff:', '');
  }
  return req.socket?.remoteAddress?.replace('::ffff:', '') || '未知';
}

function buildProxyDescriptor(proxy) {
  if (!proxy) return null;
  return {
    id: proxy.id,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port
  };
}

function buildRequestSummary(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    model: payload.model || null,
    stream: payload.stream === true,
    max_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    messages_count: Array.isArray(payload.messages) ? payload.messages.length : undefined,
    tools_count: Array.isArray(payload.tools) ? payload.tools.length : undefined,
    extra_keys: Object.keys(payload).filter((key) => !['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'tools'].includes(key))
  };
}

function buildResponseSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const summary = {};
  if (data.id) summary.id = data.id;
  if (data.created) summary.created = data.created;
  if (data.usage) summary.usage = data.usage;
  if (Array.isArray(data.choices)) {
    summary.choices = data.choices.map(choice => ({
      finish_reason: choice.finish_reason,
      role: choice.message?.role,
      has_content: !!(choice.message && choice.message.content),
      delta: choice.delta ? Object.keys(choice.delta) : undefined
    }));
  }
  if (data.error && typeof data.error === 'object') {
    summary.error = {
      code: data.error.code,
      message: data.error.message,
      type: data.error.type
    };
  }
  return summary;
}

// 定期清理过期的IP拉黑记录
setInterval(async () => {
  try {
    await db.clearExpiredBlocks();
  } catch (error) {
    console.error('清理过期IP拉黑记录失败:', error.message);
  }
}, 5 * 60 * 1000); // 每5分钟清理一次

// API密钥认证中间件（使用ADMIN_PASSWORD环境变量）
const apiAuth = (req, res, next) => {
  const apiKey = process.env.ADMIN_PASSWORD;
  
  // 如果没有设置API密钥，跳过认证
  if (!apiKey) {
    return next();
  }
  
  // 检查Authorization头
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        message: '需要API密钥认证',
        type: 'unauthorized',
        reason: '缺少Authorization头或格式错误'
      }
    });
  }
  
  // 提取并验证token
  const token = authHeader.substring(7);
  if (token !== apiKey) {
    return res.status(401).json({
      error: {
        message: 'API密钥无效',
        type: 'unauthorized',
        reason: '提供的API密钥不正确'
      }
    });
  }
  
  // 认证通过
  next();
};

// 转发聊天完成请求
router.post('/chat/completions', apiAuth, async (req, res) => {
  try {
    // 1. 检查代理服务器IP是否被上游拉黑
    // 注意：无论有多少个客户端IP发送请求，上游（硅基流动）看到的始终是代理服务器本身的IP
    // 如果代理服务器IP被拉黑，所有转发请求都会失败，因此必须拒绝所有客户端请求
    const blockInfo = await db.isIpBlocked();
    if (blockInfo) {
      const unblockTime = new Date(blockInfo.unblock_at);
      const now = new Date();
      const remainingMinutes = Math.ceil((unblockTime - now) / (1000 * 60));
      
      console.log(`代理服务器IP已被上游拉黑，拒绝所有客户端请求（剩余 ${remainingMinutes} 分钟）`);
      return res.status(503).json({
        error: {
          message: `服务器IP已被硅基流动拉黑，请等待 ${remainingMinutes} 分钟后重试`,
          type: 'ip_blocked',
          reason: blockInfo.reason || '代理服务器IP被硅基流动拉黑',
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
    let apiKeyName = `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`; // 用于日志显示
    
    // 更新当前使用的API密钥ID（用于前端显示）
    setCurrentApiKeyId(apiKeyId);
    
    let maxKeyAttempts = 10; // 最多尝试10个不同的API key
    let keyAttempts = 0;
    let lastErrorKeyId = null; // 记录最后出错的key ID

    let requestSuccess = false; // 标记整个请求是否成功
    let lastError = null; // 记录最后一个错误
    let clientDisconnected = false; // 标记客户端是否断开连接
    let requestCompleted = false; // 标记请求是否正常完成（成功或失败但已处理）
    const isStreamingRequest = req.body && req.body.stream === true;
    const clientIp = getClientIp(req);
    const requestPath = req.originalUrl || req.path || '/proxy/chat/completions';
    const upstreamUrl = `${SILICONFLOW_BASE_URL}/chat/completions`;
    const baseRequestSummary = buildRequestSummary(req.body);
    const responseTypeLabel = isStreamingRequest ? RESPONSE_TYPE_LABEL.stream : RESPONSE_TYPE_LABEL.json;
    const clientRequestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 调整客户端与服务器之间的超时时间，避免长文本响应被提前断开
    const clientTimeoutLogger = (phase = '未知阶段') => {
      if (!clientDisconnected && !requestCompleted) {
        clientDisconnected = true;
        console.warn(`客户端连接在${phase}超时（>${CLIENT_SOCKET_TIMEOUT_MS / 1000}s），停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
        try {
          if (!res.headersSent) {
            res.status(504).json({
              error: {
                message: '客户端连接超时，请稍后再试',
                type: 'gateway_timeout',
                reason: `连接持续超过 ${CLIENT_SOCKET_TIMEOUT_MS / 1000} 秒`
              }
            });
          } else {
            res.end();
          }
        } catch (e) {
          // ignore
        }
      }
    };

    req.setTimeout(CLIENT_SOCKET_TIMEOUT_MS, () => clientTimeoutLogger('客户端请求阶段'));
    res.setTimeout(CLIENT_SOCKET_TIMEOUT_MS, () => clientTimeoutLogger('返回响应阶段'));
    req.socket?.setTimeout?.(CLIENT_SOCKET_TIMEOUT_MS, () => clientTimeoutLogger('Socket'));

    // 检查客户端是否已断开的辅助函数（只检查，不设置标志）
    const checkClientDisconnected = () => {
      // 只检查 clientDisconnected 标志，不在这里设置
      // 标志应该只在事件监听器中设置，确保是真正的断开事件
      return clientDisconnected;
    };

    // 移除断开检测事件监听器的函数
    const removeDisconnectListeners = () => {
      requestCompleted = true;
      // 移除事件监听器，避免正常完成时触发断开日志
      if (req.socket) {
        req.socket.removeAllListeners('close');
        req.socket.removeAllListeners('error');
      }
      req.removeAllListeners('close');
      req.removeAllListeners('aborted');
    };

    // 监听客户端断开连接（多种事件）
    // 只有在这些事件真正触发时，才设置 clientDisconnected 标志
    // 但如果请求已经正常完成，则不记录日志
    req.on('close', () => {
      if (!clientDisconnected && !requestCompleted) {
        clientDisconnected = true;
        console.log(`客户端连接已关闭，停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
      }
    });

    req.on('aborted', () => {
      if (!clientDisconnected && !requestCompleted) {
      clientDisconnected = true;
        console.log(`客户端请求已中止，停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
      }
    });

    if (req.socket) {
      req.socket.on('close', () => {
        if (!clientDisconnected && !requestCompleted) {
          clientDisconnected = true;
          console.log(`客户端Socket已关闭，停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
        }
      });

      req.socket.on('error', () => {
        if (!clientDisconnected && !requestCompleted) {
          clientDisconnected = true;
          console.log(`客户端Socket错误，停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
        }
      });

      // 检查 socket 是否已经关闭（用于初始检查）
      if (req.socket.destroyed && !requestCompleted) {
        clientDisconnected = true;
        console.log(`客户端Socket已销毁，停止处理请求 (API Key ${apiKeyId} ${apiKeyName})`);
      }
    }

    while (keyAttempts < maxKeyAttempts && !requestSuccess && !checkClientDisconnected()) {
      // 对当前API key进行重试
      let retryCount = 0;
      let keySuccess = false; // 当前key是否成功

      while (retryCount <= MAX_RETRIES && !keySuccess && !checkClientDisconnected()) {
        const attemptStart = Date.now();
        let activeProxyForAttempt = null;
        try {
          // 在发送请求前检查客户端是否断开
          if (checkClientDisconnected()) {
            console.log(`客户端已断开，停止发送请求 (API Key ${apiKeyId} ${apiKeyName})`);
            return;
          }

          // 检查是否是流式请求
          const isStreaming = isStreamingRequest;

          // 检查是否有激活的代理
          activeProxyForAttempt = await getActiveProxy();
          let axiosConfig = {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: UPSTREAM_TIMEOUT_MS,
            responseType: isStreaming ? 'stream' : 'json'
          };

          // 如果有激活的代理，使用代理
          if (activeProxyForAttempt) {
            const agent = createProxyAgent(activeProxyForAttempt);
            if (agent) {
              axiosConfig.httpsAgent = agent;
              axiosConfig.httpAgent = agent;
            }
          }

          const response = await axios.post(
            `${SILICONFLOW_BASE_URL}/chat/completions`,
            req.body,
            axiosConfig
          );

          // 在收到响应后检查客户端是否断开
          if (checkClientDisconnected()) {
            console.log(`客户端已断开，停止处理响应 (API Key ${apiKeyId} ${apiKeyName})`);
            return;
          }

          // 成功：更新API key状态，增加调用次数
          keySuccess = true;
          requestSuccess = true;
          await markApiKeyStatus(apiKeyId, 'active');
          await db.incrementCallCount(apiKeyId);
          const durationMs = Date.now() - attemptStart;
          const proxyDescriptor = buildProxyDescriptor(activeProxyForAttempt);
          const successDetail = {
            request: baseRequestSummary,
            response: buildResponseSummary(response.data),
            proxy: proxyDescriptor
          };
          await db.recordUsage(apiKeyId, true, successDetail, {
            statusCode: response.status,
            durationMs,
            requestType: proxyDescriptor ? '代理请求' : '最终请求',
            responseType: responseTypeLabel,
            model: req.body?.model || null,
            clientIp,
            requestPath,
            upstreamUrl,
            proxyInfo: proxyDescriptor,
            requestId: clientRequestId
          });

          // 如果之前这个key被标记为错误，现在成功了，恢复为正常
          const currentKeyInfo = await db.getApiKeyById(apiKeyId);
          if (currentKeyInfo && currentKeyInfo.status === 'error') {
            await db.updateApiKeyAvailability(apiKeyId, true);
            await require('../utils/apiManager').refreshApiKeys();
            console.log(`API Key ${apiKeyId} (${apiKeyName}) 已恢复为正常状态`);
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
              if (checkClientDisconnected()) {
                if (response.data && typeof response.data.destroy === 'function') {
                  response.data.destroy();
                }
                return;
              }
              if (!res.headersSent) {
                res.writeHead(200, streamHeaders);
              }
              try {
              res.write(chunk);
              } catch (e) {
                // 如果写入失败（客户端已断开），停止流式传输
                if (response.data && typeof response.data.destroy === 'function') {
                  response.data.destroy();
                }
              }
            });

            response.data.on('end', () => {
              if (!checkClientDisconnected()) {
              res.end();
              if (shouldAutoQuery) {
                handleAutoQueryBalance(apiKeyId, autoQueryThreshold);
                }
                // 流式请求正常完成，移除断开检测监听器
                removeDisconnectListeners();
              }
            });

            response.data.on('error', (err) => {
              console.error(`流式响应错误 (API Key ${apiKeyId} ${apiKeyName}):`, err.message);
              if (!res.headersSent && !checkClientDisconnected()) {
                try {
                res.status(500).json({
                  error: {
                    message: '流式响应错误',
                    type: 'stream_error',
                    reason: err.message
                  }
                });
                } catch (e) {
                  // 客户端已断开，忽略错误
                }
              } else {
                try {
                res.end();
                } catch (e) {
                  // 客户端已断开，忽略错误
                }
              }
            });

            // 监听客户端断开，停止流式传输
            const stopStreaming = () => {
              clientDisconnected = true;
              if (response.data && typeof response.data.destroy === 'function') {
                response.data.destroy();
              }
            };
            req.on('close', stopStreaming);
            req.on('aborted', stopStreaming);
            req.socket?.on('close', stopStreaming);

            return; // 流式请求直接返回
          }

          // 非流式响应处理
          if (shouldAutoQuery) {
            handleAutoQueryBalance(apiKeyId, autoQueryThreshold);
          }

          // 非流式请求正常完成，移除断开检测监听器
          removeDisconnectListeners();
          return res.json(response.data);

        } catch (error) {
          const durationMs = Date.now() - attemptStart;
          const proxyDescriptor = buildProxyDescriptor(activeProxyForAttempt);
          // 如果客户端已断开，停止处理
          if (checkClientDisconnected()) {
            console.log(`客户端已断开，停止重试 (API Key ${apiKeyId} ${apiKeyName})`);
            return;
          }

          lastError = error;
          console.error(`API Key ${apiKeyId} (${apiKeyName}) 请求失败 (重试 ${retryCount}/${MAX_RETRIES}):`, error.message);

          // 检查是否应该使用代理（在检测50603错误之前）
          const proxyEnabled = await isProxyEnabled();
          if (proxyEnabled && shouldUseProxy(error) && retryCount === 0) {
            // 第一次失败，尝试使用代理
            console.log(`尝试使用代理进行请求 (API Key ${apiKeyId} ${apiKeyName})`);
            const proxyCallStart = Date.now();
            const proxyResult = await tryProxyRequest(
              {
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json'
                },
                timeout: UPSTREAM_TIMEOUT_MS,
                responseType: isStreamingRequest ? 'stream' : 'json'
              },
              `${SILICONFLOW_BASE_URL}/chat/completions`,
              req.body
            );
            const proxyDurationTotal = Date.now() - proxyCallStart;

            if (proxyResult && proxyResult.success) {
              // 代理成功，使用代理的响应
              const proxyResponse = proxyResult.response;
              keySuccess = true;
              requestSuccess = true;
              await markApiKeyStatus(apiKeyId, 'active');
              await db.incrementCallCount(apiKeyId);
              const proxyDescriptorForLog = buildProxyDescriptor(proxyResult.proxy);
              const proxySuccessDetail = {
                request: baseRequestSummary,
                response: buildResponseSummary(proxyResponse.data),
                proxy: proxyDescriptorForLog
              };
              await db.recordUsage(apiKeyId, true, proxySuccessDetail, {
                statusCode: proxyResponse.status,
                durationMs: proxyResult.durationMs || proxyDurationTotal,
                requestType: '代理请求',
                responseType: responseTypeLabel,
                model: req.body?.model || null,
                clientIp,
                requestPath,
                upstreamUrl,
                proxyInfo: proxyDescriptorForLog,
                requestId: clientRequestId
              });

              // 如果之前这个key被标记为错误，现在成功了，恢复为正常
              const currentKeyInfo = await db.getApiKeyById(apiKeyId);
              if (currentKeyInfo && currentKeyInfo.status === 'error') {
                await db.updateApiKeyAvailability(apiKeyId, true);
                await require('../utils/apiManager').refreshApiKeys();
                console.log(`API Key ${apiKeyId} (${apiKeyName}) 通过代理已恢复为正常状态`);
              }

              // 处理流式响应
              if (isStreaming && proxyResponse.data) {
                const streamHeaders = {
                  'Content-Type': proxyResponse.headers['content-type'] || 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no'
                };

                if (proxyResponse.headers['x-request-id']) {
                  streamHeaders['X-Request-ID'] = proxyResponse.headers['x-request-id'];
                }

                proxyResponse.data.on('data', (chunk) => {
                  if (checkClientDisconnected()) {
                    if (proxyResponse.data && typeof proxyResponse.data.destroy === 'function') {
                      proxyResponse.data.destroy();
                    }
                    return;
                  }
                  if (!res.headersSent) {
                    res.writeHead(200, streamHeaders);
                  }
                  try {
                    res.write(chunk);
                  } catch (e) {
                    if (proxyResponse.data && typeof proxyResponse.data.destroy === 'function') {
                      proxyResponse.data.destroy();
                    }
                  }
                });

                proxyResponse.data.on('end', () => {
                  if (!checkClientDisconnected()) {
                    res.end();
                    removeDisconnectListeners();
                  }
                });

                proxyResponse.data.on('error', (err) => {
                  console.error(`代理流式响应错误 (API Key ${apiKeyId} ${apiKeyName}):`, err.message);
                  if (!res.headersSent && !checkClientDisconnected()) {
                    try {
                      res.status(500).json({
                        error: {
                          message: '流式响应错误',
                          type: 'stream_error',
                          reason: err.message
                        }
                      });
                    } catch (e) {}
                  } else {
                    try {
                      res.end();
                    } catch (e) {}
                  }
                });

                const stopStreaming = () => {
                  clientDisconnected = true;
                  if (proxyResponse.data && typeof proxyResponse.data.destroy === 'function') {
                    proxyResponse.data.destroy();
                  }
                };
                req.on('close', stopStreaming);
                req.on('aborted', stopStreaming);
                req.socket?.on('close', stopStreaming);

                return; // 流式请求直接返回
              }

              // 非流式请求正常完成
              removeDisconnectListeners();
              return res.json(proxyResponse.data);
            } else {
              // 代理也失败，继续原有错误处理流程
              console.error(`所有代理都失败，继续原有错误处理流程 (API Key ${apiKeyId} ${apiKeyName})`);
            }
          }

          // 检查是否是50603错误（代理服务器IP被上游拉黑）
          // 重要：无论有多少个客户端IP，上游看到的始终是代理服务器本身的IP
          // 当检测到50603错误时，说明代理服务器IP已被上游拉黑，必须立即停止所有操作
          // 拒绝所有后续客户端请求，避免继续转发请求导致上游延长封禁时间
          if (isBusyError(error)) {
            console.error(`⚠️ 检测到50603错误（系统繁忙），代理服务器IP已被硅基流动拉黑！立即停止所有操作并拒绝后续所有客户端请求 (API Key ${apiKeyId} ${apiKeyName})`);
            
            // 立即记录代理服务器IP拉黑状态（30分钟），后续所有客户端请求将在开始就被拒绝
            if (!checkClientDisconnected()) {
              await db.blockIp('检测到50603错误（系统繁忙），代理服务器IP被上游拉黑30分钟');
              console.error(`🚫 代理服务器IP已被拉黑，30分钟内将拒绝所有客户端请求，不再向上游转发任何请求`);
            }
            
            const unblockTime = new Date(Date.now() + 30 * 60 * 1000);
            const remainingMinutes = 30;
            
            // 立即返回，停止所有后续操作（包括重试、切换key、查询余额等）
            // 不执行任何可能触发上游请求的操作
            if (!checkClientDisconnected()) {
              removeDisconnectListeners(); // 请求已处理完成（虽然是错误），移除断开检测
              return res.status(503).json({
                error: {
                  message: `服务器IP已被硅基流动拉黑，请等待 ${remainingMinutes} 分钟后重试`,
                  type: 'ip_blocked',
                  reason: '上游API返回50603错误（系统繁忙），代理服务器IP被拉黑30分钟',
                  unblock_at: unblockTime.toISOString(),
                  remaining_minutes: remainingMinutes
                }
              });
            }
            return;
          }

          // 记录错误（只保存关键错误信息，过滤对话内容）
          const errorMessage = getErrorMessage(error);
          let detailedError = errorMessage;
          let errorDetailObject = {
            message: errorMessage,
            code: error.code || null
          };
          if (error.response) {
            try {
              // 只提取关键错误信息，不保存对话内容
              const responseData = error.response.data;
              const errorInfo = {
                status: error.response.status,
                statusText: error.response.statusText
              };
              
              // 需要过滤的字段（可能包含对话内容）
              const filteredFields = ['messages', 'prompt', 'input', 'content', 'text', 'choices', 'data', 'body'];
              
              if (responseData !== undefined && responseData !== null) {
                if (typeof responseData === 'string') {
                  if (responseData.length > 200) {
                    errorInfo.upstream_error = responseData.substring(0, 200) + '... (已截断)';
                  } else {
                    errorInfo.upstream_error = responseData;
                  }
                } else if (typeof responseData === 'object') {
                  const extracted = {};
                  
                  if (responseData.error) {
                    if (typeof responseData.error === 'object') {
                      if (responseData.error.code) extracted.code = responseData.error.code;
                      if (responseData.error.message) extracted.message = responseData.error.message;
                      if (responseData.error.type) extracted.type = responseData.error.type;
                      if (responseData.error.param) extracted.param = responseData.error.param;
                    } else {
                      extracted.error = responseData.error;
                    }
                  }
                  
                  if (responseData.code !== undefined) extracted.code = responseData.code;
                  if (responseData.message !== undefined) extracted.message = responseData.message;
                  if (responseData.type !== undefined) extracted.type = responseData.type;
                  if (responseData.param !== undefined) extracted.param = responseData.param;
                  if (responseData.status !== undefined) extracted.status = responseData.status;
                  if (responseData.reason !== undefined) extracted.reason = responseData.reason;
                  
                  for (const key in responseData) {
                    if (responseData.hasOwnProperty(key) && 
                        !filteredFields.includes(key.toLowerCase()) &&
                        !extracted.hasOwnProperty(key)) {
                      const value = responseData[key];
                      if (value !== null && 
                          (typeof value === 'string' || 
                           typeof value === 'number' || 
                           typeof value === 'boolean')) {
                        if (typeof value === 'string' && value.length > 200) {
                          extracted[key] = value.substring(0, 200) + '... (已截断)';
                        } else {
                          extracted[key] = value;
                        }
                      }
                    }
                  }
                  
                  if (Object.keys(extracted).length > 0) {
                    errorInfo.upstream_error = extracted;
                  } else {
                    errorInfo.upstream_error = '[无关键错误信息]';
                  }
                } else {
                  errorInfo.upstream_error = responseData;
                }
              } else {
                errorInfo.upstream_error = null;
              }
              
              errorDetailObject = errorInfo;
              detailedError = JSON.stringify(errorInfo);
            } catch (e) {
              errorDetailObject = {
                status: error.response.status,
                statusText: error.response.statusText,
                upstream_error: '[无法解析上游错误]'
              };
              detailedError = JSON.stringify(errorDetailObject);
            }
          }
          
          // 只有在客户端未断开时才记录错误
          if (!checkClientDisconnected()) {
            await db.recordUsage(apiKeyId, false, {
              request: baseRequestSummary,
              error: errorDetailObject,
              proxy: proxyDescriptor
            }, {
              statusCode: error.response?.status || null,
              durationMs,
              requestType: proxyDescriptor ? '代理请求' : '最终请求',
              responseType: responseTypeLabel,
              model: req.body?.model || null,
              clientIp,
              requestPath,
              upstreamUrl,
              proxyInfo: proxyDescriptor,
              requestId: clientRequestId
            });
            await markApiKeyStatus(apiKeyId, 'error', errorMessage);
          }

          // 如果不是最后一次重试，等待后继续
          if (retryCount < MAX_RETRIES && !checkClientDisconnected()) {
            // 在重试前查询余额，判断是否因为欠费导致
            if (checkClientDisconnected()) {
              console.log(`客户端已断开，停止查询余额 (API Key ${apiKeyId} ${apiKeyName})`);
              return;
            }
            console.log(`API Key ${apiKeyId} (${apiKeyName}) 重试前查询余额...`);
            const balanceInfo = await queryBalance(apiKey);
            
            if (checkClientDisconnected()) {
              console.log(`客户端已断开，停止处理余额查询结果 (API Key ${apiKeyId} ${apiKeyName})`);
              return;
            }
            
            if (balanceInfo.success && balanceInfo.balance !== null) {
              await db.updateApiKeyBalance(apiKeyId, balanceInfo.balance);
              
              if (checkClientDisconnected()) {
                console.log(`客户端已断开，停止处理余额更新 (API Key ${apiKeyId} ${apiKeyName})`);
                return;
              }
              
              // 如果余额<1，标记为欠费并切换到下一个key
              if (balanceInfo.balance < 1) {
                console.log(`API Key ${apiKeyId} (${apiKeyName}) 余额不足 (¥${balanceInfo.balance.toFixed(2)})，切换到下一个key`);
                await markApiKeyStatus(apiKeyId, 'insufficient', '余额不足');
                await db.updateApiKeyAvailability(apiKeyId, false);
                await checkAndUpdateAvailability(apiKeyId);
                lastErrorKeyId = apiKeyId;
                break; // 跳出重试循环，切换到下一个key
              }
            }

            // 等待30秒后重试（检查客户端是否断开）
            if (!checkClientDisconnected()) {
              console.log(`等待 ${RETRY_DELAY / 1000} 秒后重试 API Key ${apiKeyId} (${apiKeyName})...`);
              // 分段等待，每1秒检查一次客户端连接状态（更频繁检查）
              // 在等待期间，保持当前API密钥ID的更新（用于前端显示）
              setCurrentApiKeyId(apiKeyId);
              const checkInterval = 1000; // 每1秒检查一次
              const totalChecks = Math.ceil(RETRY_DELAY / checkInterval);
              for (let i = 0; i < totalChecks && !checkClientDisconnected(); i++) {
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                // 每次检查时也更新状态
                setCurrentApiKeyId(apiKeyId);
              }
              if (checkClientDisconnected()) {
                console.log(`客户端已断开，停止重试 (API Key ${apiKeyId} ${apiKeyName})`);
                return;
              }
            } else {
              return;
            }
            retryCount++;
          } else {
            // 重试次数用尽，标记为异常状态
            if (!checkClientDisconnected()) {
            console.log(`API Key ${apiKeyId} (${apiKeyName}) 重试 ${MAX_RETRIES} 次后仍然失败，标记为异常状态`);
            await markApiKeyStatus(apiKeyId, 'error', getErrorMessage(error));
            await checkAndUpdateAvailability(apiKeyId);
            lastErrorKeyId = apiKeyId;
            }
            break; // 跳出重试循环，切换到下一个key
          }
        }
      }

      // 如果当前key成功了，检查是否需要尝试恢复之前出错的key
      if (keySuccess && lastErrorKeyId && lastErrorKeyId !== apiKeyId && !checkClientDisconnected()) {
        // 检查之前出错的key的余额
        const errorKeyInfo = await db.getApiKeyById(lastErrorKeyId);
        if (errorKeyInfo && !checkClientDisconnected()) {
          const balanceInfo = await queryBalance(errorKeyInfo.api_key);
          if (checkClientDisconnected()) {
            console.log(`客户端已断开，停止恢复之前出错的key (API Key ${lastErrorKeyId})`);
            return;
          }
          if (balanceInfo.success && balanceInfo.balance !== null) {
            await db.updateApiKeyBalance(lastErrorKeyId, balanceInfo.balance);
            
            if (checkClientDisconnected()) {
              console.log(`客户端已断开，停止处理恢复操作 (API Key ${lastErrorKeyId})`);
              return;
            }
            
            // 如果余额>=1，尝试恢复
            if (balanceInfo.balance >= 1) {
              const errorKeyName = `${errorKeyInfo.api_key.substring(0, 8)}...${errorKeyInfo.api_key.substring(errorKeyInfo.api_key.length - 4)}`;
              console.log(`尝试恢复之前出错的 API Key ${lastErrorKeyId} (${errorKeyName}) (余额: ¥${balanceInfo.balance.toFixed(2)})`);
              await markApiKeyStatus(lastErrorKeyId, 'active');
              await db.updateApiKeyAvailability(lastErrorKeyId, true);
              await require('../utils/apiManager').refreshApiKeys();
            } else {
              // 余额仍然<1，标记为错误状态（避免下次重复尝试）
              const errorKeyName = `${errorKeyInfo.api_key.substring(0, 8)}...${errorKeyInfo.api_key.substring(errorKeyInfo.api_key.length - 4)}`;
              console.log(`API Key ${lastErrorKeyId} (${errorKeyName}) 余额仍然不足，标记为错误状态`);
              await markApiKeyStatus(lastErrorKeyId, 'error', '余额不足');
              await db.updateApiKeyAvailability(lastErrorKeyId, false);
            }
          }
        }
      }

      // 如果当前key失败了，切换到下一个
      if (!keySuccess && !checkClientDisconnected()) {
        keyInfo = await switchToNextApiKey();
        if (checkClientDisconnected()) {
          console.log(`客户端已断开，停止切换API key`);
          return;
        }
        if (!keyInfo) {
          if (!checkClientDisconnected()) {
            removeDisconnectListeners(); // 请求已处理完成（虽然是错误），移除断开检测
            return res.status(503).json({
              error: {
                message: '所有API密钥都不可用',
                type: 'service_unavailable',
                reason: '所有API密钥都已尝试，但都失败了'
              }
            });
          }
          return;
        }
        apiKey = keyInfo.api_key;
        apiKeyId = keyInfo.id;
        apiKeyName = `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`;
        // 更新当前使用的API密钥ID（用于前端显示）
        setCurrentApiKeyId(apiKeyId);
        keyAttempts++;
      }
      // 如果成功，requestSuccess已经是true，循环会自动退出
    }

    // 如果客户端已断开，直接返回
    if (checkClientDisconnected()) {
      return;
    }

    // 所有key都尝试过了，仍然失败
    if (!requestSuccess) {
      if (!checkClientDisconnected()) {
        removeDisconnectListeners(); // 请求已处理完成（虽然是错误），移除断开检测
      return res.status(503).json({
        error: {
          message: '所有API密钥都不可用，请稍后重试',
          type: 'service_unavailable',
          reason: lastError ? getErrorMessage(lastError) : '未知错误'
        }
      });
      }
      return;
    }

  } catch (error) {
    console.error('代理错误:', error);
    if (typeof removeDisconnectListeners === 'function') {
      removeDisconnectListeners(); // 请求已处理完成（虽然是错误），移除断开检测
    }
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
        // 生成API密钥显示名称（前8位...后4位）
        const apiKeyName = `${keyInfo.api_key.substring(0, 8)}...${keyInfo.api_key.substring(keyInfo.api_key.length - 4)}`;
        console.log(`API Key ${apiKeyId} (${apiKeyName}) 调用次数达到 ${keyInfo.call_count}，触发自动查询余额（阈值: ${autoQueryThreshold}）`);
        queryBalance(keyInfo.api_key).then(async (balanceInfo) => {
          if (balanceInfo.success && balanceInfo.balance !== null) {
            await db.updateApiKeyBalance(apiKeyId, balanceInfo.balance);
            
            // 根据余额判断状态
            if (balanceInfo.balance < 1) {
              // 余额<1，标记为不可用
              await markApiKeyStatus(apiKeyId, 'insufficient', '余额不足');
              await db.updateApiKeyAvailability(apiKeyId, false);
              await require('../utils/apiManager').refreshApiKeys();
              console.log(`API Key ${apiKeyId} (${apiKeyName}) 余额不足 (¥${balanceInfo.balance.toFixed(2)})，已标记为不可用`);
            } else {
              // 余额>=1，确保可用状态正确
              await markApiKeyStatus(apiKeyId, 'active');
              const currentKey = await db.getApiKeyById(apiKeyId);
              if (currentKey && (currentKey.is_available === 0 || currentKey.is_available === null)) {
                await db.updateApiKeyAvailability(apiKeyId, true);
                await require('../utils/apiManager').refreshApiKeys();
              }
            }
            console.log(`API Key ${apiKeyId} (${apiKeyName}) 自动查询余额完成: ¥${balanceInfo.balance.toFixed(2)} (调用次数: ${keyInfo.call_count})`);
          }
        }).catch(err => {
          const apiKeyName = `${keyInfo.api_key.substring(0, 8)}...${keyInfo.api_key.substring(keyInfo.api_key.length - 4)}`;
          console.error(`API Key ${apiKeyId} (${apiKeyName}) 自动查询余额失败:`, err.message);
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
