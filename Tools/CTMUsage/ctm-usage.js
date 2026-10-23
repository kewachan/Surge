/* CTM Usage Info v1.0.2 — account data stays between Surge and CTM. */
(function () {
  'use strict';

  const ENDPOINT = 'https://www.ctm.net/crm_api/crm-cluster-server/p/by/home/user/infoV2';
  const UNITS = {B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4};

  run().then($done).catch(error => {
    // Never log request headers, the token, raw server responses or errors.
    const messages = {
      missing: '請在 module 參數填入自己的 token，再重新整理。',
      token: 'Token 格式不正確，請貼上 Authorization token（可包含 Bearer）。',
      auth: 'Token 已失效或未獲授權，請從 CTM App 重新取得並更新。',
      network: '查詢連線失敗，請稍後重新整理。',
      redirect: 'CTM 接口重新導向，已停止查詢，token 未轉發到其他網址。',
      response: 'CTM 回應未包含有效用量，請稍後再試或更新 token。'
    };
    $done({title: 'CTM Usage Info', content: messages[error.kind] || messages.response,
      style: error.kind === 'missing' ? 'info' : 'error'});
  });

  function fail(kind) { const error = new Error(kind); error.kind = kind; throw error; }

  function options() {
    const values = {};
    for (const part of String(typeof $argument === 'string' ? $argument : '').split('&')) {
      const at = part.indexOf('=');
      if (at < 1) continue;
      try { values[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1)); }
      catch (_) { fail('token'); }
    }
    const token = String(values.token || '').replace(/^\s*Bearer(?:\s+|$)/i, '').trim();
    if (!token || token === 'paste-token-here') fail('missing');
    if (token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) fail('token');
    const timeout = Number(values.timeout);
    return {token, timeout: Number.isFinite(timeout) && timeout >= 1 ? Math.min(15, timeout) : 8};
  }

  function fetchUsage(config) {
    return new Promise((resolve, reject) => {
      $httpClient.get({
        url: ENDPOINT,
        headers: {Authorization: `Bearer ${config.token}`, Accept: 'application/json'},
        timeout: config.timeout,
        'auto-redirect': false,
        'auto-cookie': false
      }, (error, response, data) => {
        if (error) { reject({kind: 'network'}); return; }
        const status = Number(response && (response.status || response.statusCode));
        if (status === 401 || status === 403) { reject({kind: 'auth'}); return; }
        if (status >= 300 && status < 400) { reject({kind: 'redirect'}); return; }
        if (status !== 200) { reject({kind: 'response'}); return; }
        try {
          const payload = JSON.parse(data);
          if (String(payload.code) !== '10000000') {
            const authError = /token|unauthori[sz]ed|login|session|授權|授权|登入|登錄|登录|過期|过期/i.test(String(payload.message || ''));
            reject({kind: authError ? 'auth' : 'response'});
            return;
          }
          resolve(payload.data && payload.data.usageVO);
        } catch (_) { reject({kind: 'response'}); }
      });
    });
  }

  function amount(value, multiplier, optional = false) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
      if (optional) return null;
      fail('response');
    }
    if (!['number', 'string'].includes(typeof value)) fail('response');
    const bytes = Number(value) * multiplier;
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER) fail('response');
    return bytes;
  }

  function format(bytes) {
    if (bytes === 0) return '0 MB';
    const names = Object.keys(UNITS);
    let unit = names[0];
    for (const name of names) { if (bytes >= UNITS[name]) unit = name; }
    return `${(bytes / UNITS[unit]).toFixed(1).replace(/\.0$/, '')} ${unit}`;
  }

  function updatedAt() {
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }

  async function run() {
    const usage = await fetchUsage(options());
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail('response');
    const multiplier = UNITS[String(usage.dataUnit || '').toUpperCase()];
    if (!multiplier) fail('response');
    const used = amount(usage.usedBalance, multiplier);
    const available = amount(usage.availableBalance, multiplier);
    const total = amount(usage.totalBalance, multiplier, true);
    const fullSpeed = usage.categoryType === 'SPEED_DATA';
    const lines = [];
    let color = '#34C759';
    if (total > 0) {
      // Use the API's remaining balance, not total minus all traffic: an
      // unlimited plan can continue recording usage above its full-speed cap.
      const ratio = Math.max(0, Math.min(1, (total - available) / total));
      const filled = Math.round(ratio * 10);
      const block = ratio >= 1 ? '🟧' : ratio >= 0.8 ? '🟨' : '🟩';
      color = ratio >= 1 ? '#FF9500' : ratio >= 0.8 ? '#FFCC00' : color;
      lines.push(`${block.repeat(filled)}${'⬜'.repeat(10 - filled)} ${Math.round(ratio * 100)}%`);
    } else {
      // A missing/zero quota is not evidence that an unlimited plan is empty.
      lines.push('配額未提供，無法計算用量條');
    }
    lines.push(`已用 ${format(used)} · ${fullSpeed ? '全速' : ''}剩餘 ${format(available)}`);
    if (total > 0) lines.push(`${fullSpeed ? '全速' : ''}配額 ${format(total)}${usage.isUnlimited === true ? ' · 無限數據' : ''}`);
    else if (usage.isUnlimited === true) lines.push('無限數據方案');
    lines.push(`更新 ${updatedAt()}（澳門時間）`);
    return {title: 'CTM Usage Info', content: lines.join('\n'), icon: 'chart.bar.fill', 'icon-color': color};
  }
})();
