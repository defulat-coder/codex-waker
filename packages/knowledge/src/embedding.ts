export interface EmbeddingAdapter {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

/** Deterministic, offline embedding intended for local verification, not semantic quality. */
export class LocalHashEmbedding implements EmbeddingAdapter {
  readonly model = 'local-hash-v1';

  constructor(readonly dimensions = 64) {
    if (!Number.isInteger(dimensions) || dimensions < 8)
      throw new Error('Embedding dimensions must be an integer >= 8');
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
      for (const token of tokens) {
        const hash = hashToken(token);
        const index = hash % this.dimensions;
        vector[index] = (vector[index] ?? 0) + (hash & 1 ? 1 : -1);
      }
      return normalize(vector);
    });
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
