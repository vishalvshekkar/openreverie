// A deterministic, offline embedding stub for the retrieval evaluation
// harness (retrievalEval.test.ts). No network call, no API key: the same
// text always hashes to the same vector.
//
// FakeEmbeddingProvider in @openreverie/providers hashes each text as one
// opaque unit, so it gives cosine similarity 1.0 for an exact string match
// and something close to noise otherwise. That is fine for the existing
// unit tests, which only ever check exact-match ranking, but it is useless
// for this harness: the fixture corpus is built around near-miss documents
// that share a subject and differ in precision and date, and the vector
// lane needs to tell those apart in a non-random order for recall@k to mean
// anything.
//
// BagOfWordsEmbeddingProvider hashes each token separately and sums the
// per-token vectors. Two texts that share content words end up with a
// meaningfully higher cosine similarity than two that do not, which is a
// crude but real approximation of semantic similarity, and it is what lets
// this harness's vector-lane numbers be more than noise.

import type { EmbeddingProvider } from '@openreverie/providers'

const DIMENSIONS = 64

// Left in, these dominate the bag-of-words sum and wash out the words that
// actually distinguish one fixture document from another.
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'still',
  'that',
  'the',
  'there',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'yet',
  'you',
  'your',
])

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
}

// A deterministic pseudo-random vector for one token, one component at a
// time, so tokens that differ by even one character land in unrelated
// directions and there is no bias from a token's raw hash across
// dimensions.
function tokenVector(token: string): number[] {
  const vector: number[] = []
  let seed = hash32(token)
  for (let i = 0; i < DIMENSIONS; i++) {
    seed = hash32(`${seed}:${i}`)
    vector.push((seed % 2000) / 1000 - 1)
  }
  return vector
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

export class BagOfWordsEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'eval-bag-of-words-stub'

  embed(_model: string, texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const tokens = tokenize(text)
        // No content words at all (an empty chunk, or every word was a
        // stopword): fall back to hashing the raw text so the call still
        // returns a real vector rather than the zero vector, which
        // cosineSimilarity treats as similarity 0 against everything.
        const words = tokens.length > 0 ? tokens : [text]
        const sum = new Array(DIMENSIONS).fill(0)
        for (const word of words) {
          const wordVector = tokenVector(word)
          for (let i = 0; i < DIMENSIONS; i++) {
            sum[i] += wordVector[i] ?? 0
          }
        }
        return normalize(sum)
      }),
    )
  }
}
