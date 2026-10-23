/* CTM Usage Info v1.0.4 — account data stays between Surge and CTM. */
(function () {
  'use strict';

  const ENDPOINT = 'https://www.ctm.net/crm_api/crm-cluster-server/p/by/home/user/infoV2';
  const UNITS = {B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4};
  const ICON = 'simcard';
  const ICON_COLOR = '#6699FF';

  run().then($done).catch(error => {
    // Never log request headers, the token, raw server responses or errors.
    const messages = {
      missing: 'Set your CTM token in the module parameters, then refresh.',
      token: 'Invalid token format. Paste your Authorization token; the Bearer prefix is optional.',
      auth: 'Token expired or unauthorized. Obtain a new token from the CTM app.',
      network: 'Connection failed. Please refresh and try again.',
      redirect: 'CTM redirected the request. Stopped without forwarding your token.',
      response: 'CTM returned invalid usage data. Please try again or update your token.'
    };
    $done({title: 'Remaining: -- MB', content: messages[error.kind] || messages.response,
      style: error.kind === 'missing' ? 'info' : 'error', icon: ICON, 'icon-color': ICON_COLOR});
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
    // Remaining balance comes directly from CTM: unlimited traffic can exceed
    // the full-speed cap, so do not derive it from total minus used traffic.
    const remainingMB = (available / UNITS.MB).toFixed(1).replace(/\.0$/, '');
    const lines = [
      `Used: ${format(used)}`,
      `Updated: ${updatedAt()}`
    ];
    return {title: `Remaining: ${remainingMB} MB`, content: lines.join('\n'), icon: ICON, 'icon-color': ICON_COLOR};
  }
})();
