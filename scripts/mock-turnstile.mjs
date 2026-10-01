#!/usr/bin/env node
/**
 * 本地测试用的假 Turnstile siteverify 服务。
 *
 *   TURNSTILE_VERIFY_URL=http://127.0.0.1:8798/siteverify   （wrangler dev 的 .dev.vars 里）
 *
 * 规则：token 以 PASS 开头 → 验证成功；以 DUP 开头 → 返回 timeout-or-duplicate；
 *      其它 → invalid-input-response。这样就能在本地覆盖"通过/重放/失败"三条路径。
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8798);
const log = (...a) => console.log(`[mock-turnstile ${new Date().toISOString().slice(11, 19)}]`, ...a);

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const ct = req.headers['content-type'] || '';
    const params = new URLSearchParams();

    if (ct.includes('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(body)) params.set(k, v);
    } else if (ct.includes('multipart/form-data')) {
      // 极简 multipart 解析：按 boundary 切成段，取 name= 与空行后的值
      const boundary = (ct.match(/boundary=([^;]+)/) || [])[1];
      for (const part of body.split(`--${boundary}`)) {
        const name = (part.match(/name="([^"]+)"/) || [])[1];
        if (!name) continue;
        const value = part.split('\r\n\r\n')[1];
        if (value !== undefined) params.set(name, value.replace(/\r?\n-*$/, '').trim());
      }
    } else {
      for (const [k, v] of new URLSearchParams(body)) params.set(k, v);
    }

    const response = params.get('response') || '';
    const secret = params.get('secret') || '';
    log(`ct=${ct || '(无)'} bodyLen=${body.length} 解析出字段=${[...params.keys()].join(',') || '(无)'}`);
    log(`secret=${secret ? secret.slice(0, 10) + '…' : '(空)'} response=${response || '(空)'}`);

    const send = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (!secret) return send({ success: false, 'error-codes': ['missing-input-secret'] });
    if (!response) return send({ success: false, 'error-codes': ['missing-input-response'] });
    if (response.startsWith('PASS')) {
      return send({ success: true, challenge_ts: new Date().toISOString(), hostname: 'llm.yexiangha.top', 'error-codes': [] });
    }
    if (response.startsWith('DUP')) return send({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    return send({ success: false, 'error-codes': ['invalid-input-response'] });
  });
}).listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/siteverify`));
