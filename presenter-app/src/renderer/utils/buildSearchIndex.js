// Inverted keyword index over flow name + description.
// Built once at session start, rebuilt only when flows.json changes.
// Lookup is sub-millisecond. findBestFlow returns null on no match (does not throw).

const STOPWORDS = new Set([
  'the', 'and', 'for', 'our', 'you', 'this', 'that',
  'with', 'from', 'show', 'take', 'let', 'can', 'will', 'now'
]);

function tokenize(text) {
  return text
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function buildSearchIndex(flows) {
  const index = new Map(); // keyword -> Set<flowId>

  for (const flow of flows) {
    // Index from name and description only - not steps.
    const text = `${flow.name || ''} ${flow.description || ''}`.toLowerCase();
    const words = tokenize(text);

    for (const word of words) {
      if (!index.has(word)) index.set(word, new Set());
      index.get(word).add(flow.id);
    }
  }

  return index;
}

function findBestFlow(intent, index, flows) {
  if (!intent || !index || !flows || flows.length === 0) return null;

  const words = tokenize(intent.toLowerCase());
  const scores = new Map(); // flowId -> score

  for (const word of words) {
    const matches = index.get(word);
    if (!matches) continue;
    for (const flowId of matches) {
      scores.set(flowId, (scores.get(flowId) || 0) + 1);
    }
  }

  if (scores.size === 0) return null;

  let bestId = null;
  let bestScore = 0;
  for (const [flowId, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestId = flowId;
    }
  }

  return flows.find((f) => f.id === bestId) || null;
}

module.exports = { buildSearchIndex, findBestFlow, tokenize, STOPWORDS };
