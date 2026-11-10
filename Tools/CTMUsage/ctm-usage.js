/* CTM Usage Info v1.0.8 — account data stays between Surge and CTM. */
(function () {
  'use strict';

  const ENDPOINT = 'https://www.ctm.net/crm_api/crm-cluster-server/p/by/home/user/infoV2';
  const UNITS = {B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4};
  const ICON = 'simcard';
  const ICON_COLOR = '#6699FF';

  run().then($done).catch(error => $done(errorPanel(error.kind)));

  function errorPanel(kind) {
    // Never log request headers, the token, raw server responses or errors.
    const messages = {
      missing: 'Set your CTM token in the module parameters, then refresh.',
      token: 'Invalid token format. Paste your Authorization token; the Bearer prefix is optional.',
      auth: 'Token expired or unauthorized. Obtain a new token from the CTM app.',
      network: 'Connection failed. Please refresh and try again.',
      redirect: 'CTM redirected the request. Stopped without forwarding your token.',
      response: 'CTM returned invalid usage data. Please try again or update your token.'
    };
    return {title: 'Remaining: -- MB', content: messages[kind] || messages.response,
      style: kind === 'missing' ? 'info' : 'error', icon: ICON, 'icon-color': ICON_COLOR};
  }

  function fail(kind) { const error = new Error(kind); error.kind = kind; throw error; }

  function options() {
    const values = Object.create(null);
    for (const part of String(typeof $argument === 'string' ? $argument : '').split('&')) {
      const at = part.indexOf('=');
      if (at < 1) continue;
      try { values[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1)); }
      catch (_) { values[part.slice(0, at)] = null; }
    }
    const tokens = [values.token];
    const second = String(values.token2 || '').trim();
    if (values.token2 === null || (second && second.toLowerCase() !== 'none')) tokens.push(values.token2);
    const timeout = Number(values.timeout);
    return {tokens, timeout: Number.isFinite(timeout) && timeout >= 1 ? Math.min(15, timeout) : 8};
  }

  function normalizeToken(value) {
    if (value === null) fail('token');
    const token = String(value || '').replace(/^\s*Bearer(?:\s+|$)/i, '').trim();
    if (!token || token === 'paste-token-here') fail('missing');
    if (token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) fail('token');
    return token;
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

  function amount(value, multiplier) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
      fail('response');
    }
    if (!['number', 'string'].includes(typeof value)) fail('response');
    const bytes = Number(value) * multiplier;
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER) fail('response');
    return bytes;
  }

  function format(bytes) {
    if (bytes < UNITS.GB) return `${Math.round(bytes / UNITS.MB)} MB`;
    const unit = bytes >= UNITS.TB ? 'TB' : 'GB';
    return `${(bytes / UNITS[unit]).toFixed(1)} ${unit}`;
  }

  function combined(first, second) {
    const known = (first || 0) + (second || 0);
    const unit = known < UNITS.GB ? 'MB' : known >= UNITS.TB ? 'TB' : 'GB';
    const decimals = unit === 'MB' ? 0 : 1;
    const scale = 10 ** decimals;
    const values = [first, second].map(value => value === undefined ? undefined
      : Math.round(value / UNITS[unit] * scale));
    const display = value => value === undefined ? '--' : (value / scale).toFixed(decimals);
    const total = values.includes(undefined) ? undefined : values[0] + values[1];
    return `${display(values[0])} + ${display(values[1])} = ${display(total)} ${unit}`;
  }

  function updatedAt() {
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }

  async function readPlan(value, timeout) {
    try {
      const usage = await fetchUsage({token: normalizeToken(value), timeout});
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail('response');
      const multiplier = UNITS[String(usage.dataUnit || '').toUpperCase()];
      if (!multiplier) fail('response');
      const used = amount(usage.usedBalance, multiplier);
      const available = amount(usage.availableBalance, multiplier);
      // Remaining balance comes directly from CTM: unlimited traffic can exceed
      // the full-speed cap, so do not derive it from total minus used traffic.
      return {used, available};
    } catch (error) {
      return {error: error.kind || 'response'};
    }
  }

  async function run() {
    const config = options();
    const [first, second] = await Promise.all(config.tokens.map(token => readPlan(token, config.timeout)));
    if (!second) {
      if (first.error) return errorPanel(first.error);
      return {title: `Remaining: ${format(first.available)}`,
        content: `Used: ${format(first.used)}\nUpdated: ${updatedAt()}`, icon: ICON, 'icon-color': ICON_COLOR};
    }
    const errors = [];
    if (first.error) errors.push(`Token: ${errorPanel(first.error).content}`);
    if (second.error) errors.push(`Token 2: ${errorPanel(second.error).content}`);
    if (first.error && second.error) {
      const panel = errorPanel(first.error);
      panel.content = errors.join('\n');
      if (second.error !== 'missing') panel.style = 'error';
      return panel;
    }
    return {title: `Remaining: ${combined(first.available, second.available)}`,
      content: [`Used: ${combined(first.used, second.used)}`, `Updated: ${updatedAt()}`, ...errors].join('\n'),
      icon: ICON, 'icon-color': ICON_COLOR};
  }
})();
