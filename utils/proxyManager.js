const db = require('../db');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// 代理状态管理
let activeProxyId = null;
let proxyExpiresAt = null;

// 检查代理是否启用
async function isProxyEnabled() {
  try {
    return await db.getProxyEnabled();
  } catch (error) {
    console.error('检查代理状态失败:', error);
    return false;
  }
}

// 获取当前激活的代理
async function getActiveProxy() {
  try {
    // 检查是否已过期
    if (proxyExpiresAt && new Date() > new Date(proxyExpiresAt)) {
      // 代理已过期，清除状态
      await db.clearProxyState();
      activeProxyId = null;
      proxyExpiresAt = null;
      return null;
    }

    // 从数据库获取状态
    const state = await db.getProxyState();
    if (state && state.active_proxy_id) {
      activeProxyId = state.active_proxy_id;
      proxyExpiresAt = state.expires_at;
      
      // 获取代理配置
      const configs = await db.getAllProxyConfigs();
      const proxy = configs.find(p => p.id === activeProxyId);
      return proxy || null;
    }
    
    return null;
  } catch (error) {
    console.error('获取激活代理失败:', error);
    return null;
  }
}

// 设置激活的代理（1小时后过期）
async function setActiveProxy(proxyId) {
  try {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1小时后
    await db.setProxyState(proxyId, expiresAt.toISOString());
    activeProxyId = proxyId;
    proxyExpiresAt = expiresAt.toISOString();
    console.log(`代理已激活: ID ${proxyId}，将在 ${expiresAt.toLocaleString()} 过期`);
  } catch (error) {
    console.error('设置激活代理失败:', error);
    throw error;
  }
}

// 清除激活的代理
async function clearActiveProxy() {
  try {
    await db.clearProxyState();
    activeProxyId = null;
    proxyExpiresAt = null;
    console.log('代理状态已清除，恢复使用本地IP');
  } catch (error) {
    console.error('清除代理状态失败:', error);
    throw error;
  }
}

// 创建代理agent
function createProxyAgent(proxyConfig) {
  if (!proxyConfig) return null;

  const { type, host, port, username, password } = proxyConfig;
  const proxyUrl = username && password
    ? `${type}://${username}:${password}@${host}:${port}`
    : `${type}://${host}:${port}`;

  try {
    switch (type) {
      case 'socks5':
        return new SocksProxyAgent(proxyUrl);
      case 'http':
        return new HttpProxyAgent(proxyUrl);
      case 'https':
        return new HttpsProxyAgent(proxyUrl);
      default:
        console.error(`不支持的代理类型: ${type}`);
        return null;
    }
  } catch (error) {
    console.error(`创建代理agent失败:`, error);
    return null;
  }
}

// 尝试使用代理发送请求
async function tryProxyRequest(axiosConfig, url, data) {
  const axios = require('axios');
  const enabled = await isProxyEnabled();
  
  if (!enabled) {
    return null; // 代理未启用，返回null表示不使用代理
  }

  // 检查是否已有激活的代理
  let activeProxy = await getActiveProxy();
  if (activeProxy) {
    const agent = createProxyAgent(activeProxy);
    if (agent) {
      const testConfig = {
        ...axiosConfig,
        httpsAgent: agent,
        httpAgent: agent
      };
      try {
        const attemptStart = Date.now();
        const response = await axios.post(url, data, testConfig);
        const durationMs = Date.now() - attemptStart;
        return { success: true, response, proxy: activeProxy, durationMs };
      } catch (error) {
        console.error(`使用激活代理失败 (${activeProxy.type}://${activeProxy.host}:${activeProxy.port}):`, error.message);
        // 激活的代理失败，清除状态，尝试其他代理
        await clearActiveProxy();
      }
    }
  }

  // 尝试所有可用的代理
  const configs = await db.getAllProxyConfigs();
  for (const proxy of configs) {
    const agent = createProxyAgent(proxy);
    if (!agent) continue;

    const testConfig = {
      ...axiosConfig,
      httpsAgent: agent,
      httpAgent: agent
    };

    try {
      const attemptStart = Date.now();
      const response = await axios.post(url, data, testConfig);
      const durationMs = Date.now() - attemptStart;
      // 成功，设置这个代理为激活状态
      await setActiveProxy(proxy.id);
      console.log(`代理连接成功: ${proxy.type}://${proxy.host}:${proxy.port}，已激活（1小时后自动恢复本地IP）`);
      return { success: true, response, proxy, durationMs };
    } catch (error) {
      console.error(`代理测试失败 (${proxy.type}://${proxy.host}:${proxy.port}):`, error.message);
      // 继续尝试下一个代理
    }
  }

  // 所有代理都失败
  console.error('所有代理都失败，继续原有错误处理流程');
  return { success: false, error: '所有代理都失败' };
}

// 检查是否应该使用代理（基于错误类型）
function shouldUseProxy(error) {
  // 如果是IP被拉黑（50603错误）或其他网络错误，应该尝试代理
  if (!error || !error.response) {
    // 网络错误，尝试代理
    return true;
  }

  const status = error.response.status;
  // 5xx错误或403/429等可能被拉黑的错误
  if (status >= 500 || status === 403 || status === 429) {
    return true;
  }

  // 检查是否是50603错误（IP被拉黑）
  const responseData = error.response.data;
  if (responseData) {
    if (typeof responseData === 'object') {
      if (responseData.code === 50603 || responseData.code === '50603') {
        return true;
      }
      if (responseData.error && typeof responseData.error === 'object') {
        if (responseData.error.code === 50603 || responseData.error.code === '50603') {
          return true;
        }
      }
    }
  }

  return false;
}

module.exports = {
  isProxyEnabled,
  getActiveProxy,
  setActiveProxy,
  clearActiveProxy,
  createProxyAgent,
  tryProxyRequest,
  shouldUseProxy
};

