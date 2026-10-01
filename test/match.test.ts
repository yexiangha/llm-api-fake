import { strict as assert } from 'node:assert';
import test from 'node:test';
import { modelMatches, pickRule, type Rule } from '../src/lib/match.ts';

function rule(partial: Partial<Rule>): Rule {
  return { id: 'r', name: 'r', enabled: true, content: 'x', ...partial };
}

const rules: Rule[] = [
  rule({ id: 'default', name: '兜底', isDefault: true, priority: -10, content: '兜底内容' }),
  rule({ id: 'kw', name: '关键词', match: { keyword: '天气' }, content: '关键词命中' }),
  rule({ id: 're', name: '正则', match: { regex: '^帮我.*代码' }, content: '正则命中' }),
  rule({ id: 'model', name: '模型', match: { model: 'gpt-4*' }, content: '模型命中' }),
  rule({ id: 'off', name: '停用', enabled: false, match: { keyword: '天气' }, content: '不该命中' }),
];

test('modelMatches 支持精确/通配/正则', () => {
  assert.ok(modelMatches('gpt-4o', 'gpt-4o'));
  assert.ok(modelMatches('GPT-4O', 'gpt-4o'));
  assert.ok(modelMatches('gpt-4*', 'gpt-4o-mini'));
  assert.ok(modelMatches('/^claude-/', 'claude-3-5-sonnet'));
  assert.ok(!modelMatches('gpt-4*', 'claude-3'));
  assert.ok(modelMatches('', 'anything'));
});

test('pickRule 关键词命中优先于模型名', () => {
  const hit = pickRule(rules, { model: 'gpt-4o', text: 'user: 今天天气怎么样' });
  assert.equal(hit?.id, 'kw');
});

test('pickRule 正则命中优先级最高', () => {
  const hit = pickRule(rules, { model: 'gpt-4o', text: 'user: 帮我写代码', regexText: '帮我写代码' });
  assert.equal(hit?.id, 're');
  // 正则锚定了 "帮我" 开头，这句不满足正则，于是落到模型名规则
  assert.equal(pickRule(rules, { model: 'gpt-4o', text: 'user: 随便写点代码', regexText: '随便写点代码' })?.id, 'model');
});

test('pickRule 模型名命中', () => {
  const hit = pickRule(rules, { model: 'gpt-4o-mini', text: 'user: 随便聊聊' });
  assert.equal(hit?.id, 'model');
});

test('pickRule 无命中时回落到兜底规则', () => {
  const hit = pickRule(rules, { model: 'fake-x', text: 'user: 随便聊聊' });
  assert.equal(hit?.id, 'default');
});

test('pickRule 忽略停用规则', () => {
  const hit = pickRule(rules, { model: 'x', text: '天气' });
  assert.equal(hit?.id, 'kw');
  assert.notEqual(hit?.id, 'off');
});

test('pickRule 无兜底规则时返回 null', () => {
  const hit = pickRule([rule({ id: 'only', match: { keyword: 'zzz' } })], { model: 'x', text: '天气' });
  assert.equal(hit, null);
});

test('pickRule 非法正则不会抛错', () => {
  const bad = [rule({ id: 'bad', match: { regex: '([' } }), rule({ id: 'd', isDefault: true })];
  const hit = pickRule(bad, { model: 'x', text: 'hello' });
  assert.equal(hit?.id, 'd');
});

test('pickRule 同分时按 priority 再按更新时间', () => {
  const candidates = [
    rule({ id: 'a', match: { keyword: 'x' }, priority: 1, updatedAt: '2026-01-01T00:00:00Z' }),
    rule({ id: 'b', match: { keyword: 'x' }, priority: 5, updatedAt: '2025-01-01T00:00:00Z' }),
  ];
  assert.equal(pickRule(candidates, { model: 'm', text: 'x' })?.id, 'b');
});
