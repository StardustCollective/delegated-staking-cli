import {formatDag} from './api.js';

const EXPLANATIONS: [name: string, explain: (text: string) => string][] = [
  ['InsufficientRegistrationBalance', (text) => {
    const balance = /\bbalance=(\d+)/.exec(text)?.[1];
    const minimum = /\bminimum=(\d+)/.exec(text)?.[1];
    const amounts = balance && minimum
      ? `Your balance (${formatDag(Number(balance))}) is under the minimum (${formatDag(Number(minimum))})`
      : 'Your balance is under the minimum';
    return `${amounts} the network requires for delegated staking. Add DAG to this account and try again.`;
  }],
  ['InvalidParent', () => 'The registration changed since this tool read it. Run the tool again.'],
  ['TooLargeName', () => 'The name is longer than 140 characters.'],
  ['TooLargeDescription', () => 'The description is longer than 140 characters.'],
  ['InvalidName', () => 'The network did not accept the name. Try plain letters, digits and punctuation.'],
  ['InvalidDescription', () => 'The network did not accept the description. Try plain letters, digits and punctuation.'],
  ['InvalidSigned', () => 'The network did not accept the signature on the request.'],
  ['NodeNotInSeedList', () => "This account is not on the network's list of accounts allowed to register."],
  ['InvalidRewardValue', () => 'The network did not accept the commission this tool sends. A newer version of this tool may be needed.'],
  ['InvalidProofsCount', () => 'The request must be signed by exactly one key. A newer version of this tool may be needed.'],
];

// The server's 400 body is often a JSON-encoded string; show it without the quotes.
function unquote(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Not JSON: show as is.
  }
  return text.trim();
}

export function explainServerError(text: string): string {
  const shown = unquote(text).trim();
  if (!shown) return 'The network rejected the request.';
  const found = EXPLANATIONS.filter(([name]) => new RegExp(`\\b${name}\\b`).test(shown));
  const label = `Server response: ${shown}`;
  if (found.length === 0) return label;
  return [...found.map(([, explain]) => explain(shown)), '', label].join('\n');
}
