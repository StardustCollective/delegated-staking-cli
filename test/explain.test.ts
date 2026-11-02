import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';
import {explainServerError} from '../src/explain.js';

const insufficient = readFileSync(new URL('./fixtures/insufficient-balance-error.txt', import.meta.url), 'utf8');

test('InsufficientRegistrationBalance: plain amounts, then the server text without JSON quotes', () => {
  const out = explainServerError(insufficient);
  expect(out).toContain('Your balance (0 DAG) is under the minimum (250,000 DAG)');
  expect(out).toContain(
    'Server response: InsufficientRegistrationBalance{source=DAG7r19DkWQSsmDMM1CGh4seEVdPqYB8hkgs82i1,balance=0,minimum=25000000000000}',
  );
  expect(out).not.toContain('"InsufficientRegistrationBalance');
  expect(out.indexOf('Your balance')).toBeLessThan(out.indexOf('Server response:'));
});

test.each([
  ['InvalidParent', /changed since this tool read it.*run the tool again/i],
  ['TooLargeName', /name is longer than 140 characters/i],
  ['TooLargeDescription', /description is longer than 140 characters/i],
  ['InvalidName', /did not accept the name/i],
  ['InvalidDescription', /did not accept the description/i],
  ['InvalidSigned', /signature/i],
  ['NodeNotInSeedList', /not on the network's list/i],
  ['InvalidRewardValue', /commission/i],
  ['InvalidProofsCount', /exactly one key/i],
])('%s is explained, followed by the server text', (name, pattern) => {
  const text = `${name}{source=DAG7r19DkWQSsmDMM1CGh4seEVdPqYB8hkgs82i1}`;
  const out = explainServerError(text);
  expect(out).toMatch(pattern);
  expect(out.endsWith(`Server response: ${text}`)).toBe(true);
});

test('a JSON-quoted error is also recognized', () => {
  const out = explainServerError(JSON.stringify('InvalidParent{x=1}'));
  expect(out).toMatch(/run the tool again/i);
  expect(out).toContain('Server response: InvalidParent{x=1}');
});

test('several errors in one response are each explained', () => {
  const out = explainServerError('List(TooLargeName{}, InvalidParent{})');
  expect(out).toMatch(/name is longer/i);
  expect(out).toMatch(/run the tool again/i);
  expect(out).not.toMatch(/description is longer/i);
});

test('InvalidName does not also match TooLargeName and the reverse', () => {
  expect(explainServerError('TooLargeName{}')).not.toMatch(/did not accept the name/i);
  expect(explainServerError('InvalidName{}')).not.toMatch(/longer than/i);
});

test('unknown JSON-string body: unquoted and labelled, no explanation', () => {
  expect(explainServerError('"Foo{x=1}"')).toBe('Server response: Foo{x=1}');
});

test('unknown plain text: labelled, no explanation', () => {
  expect(explainServerError('SomethingElse happened')).toBe('Server response: SomethingElse happened');
});

test('empty or whitespace-only body gives a plain fallback', () => {
  expect(explainServerError('')).toBe('The network rejected the request.');
  expect(explainServerError('  \n')).toBe('The network rejected the request.');
  expect(explainServerError('""')).toBe('The network rejected the request.');
});
