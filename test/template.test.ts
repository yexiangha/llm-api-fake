import { strict as assert } from 'node:assert';
import test from 'node:test';
import { messagesToText, lastUserMessage, renderTemplate, roughWords, randomTag, type TemplateVars } from '../src/lib/template.ts';

const vars: TemplateVars = {
  user: '你好呀',
  messages: 'user: 你好呀',
  model: 'fake-gpt-4o',
  id: 'chatcmpl-abc',
  time: '2026-01-01T00:00:00.000Z',
  rand: 'ABCD',
  hash: 'deadbeef',
  path: '/v1/chat/completions',
  method: 'POST',
  key: 'sk-test',
  len: '3',
  words: '3',
};

test('renderTemplate 替换已知占位符', () => {
  assert.equal(renderTemplate('你说：{{user}}', vars), '你说：你好呀');
  assert.equal(renderTemplate('{{ model }} / {{hash}}', vars), 'fake-gpt-4o / deadbeef');
});

test('renderTemplate 保留未知占位符', () => {
  assert.equal(renderTemplate('{{unknown}} 和 {{ user }}', vars), '{{unknown}} 和 你好呀');
});

test('renderTemplate 支持重复与多占位符', () => {
  const out = renderTemplate('{{rand}}-{{rand}}-{{len}}', vars);
  assert.match(out, /^ABCD-ABCD-3$/);
});

test('messagesToText 拼接角色与内容', () => {
  assert.equal(
    messagesToText([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]),
    'system: 你是助手\nuser: 你好',
  );
});

test('messagesToText 处理非字符串 content', () => {
  assert.equal(messagesToText([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), 'user: [{"type":"text","text":"hi"}]');
  assert.equal(messagesToText([{ role: 'user', content: null }]), 'user: ');
});

test('lastUserMessage 取最后一条 user', () => {
  assert.equal(
    lastUserMessage([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '最后一句' },
    ]),
    '最后一句',
  );
  assert.equal(lastUserMessage([{ role: 'system', content: '只有 system' }]), '');
});

test('roughWords 中英混合粗算', () => {
  assert.equal(roughWords('你好世界'), '4');
  assert.equal(roughWords('hello world foo'), '3');
  assert.equal(roughWords('你好 world'), '3');
});

test('randomTag 形状稳定', () => {
  const tag = randomTag();
  assert.equal(tag.length, 4);
  assert.match(tag, /^[A-Z2-9]{4}$/);
});
