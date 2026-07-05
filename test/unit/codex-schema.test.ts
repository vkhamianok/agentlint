import { describe, expect, it } from 'vitest';

import { toStrictSchema } from '../../src/engine/codex.js';
import { reviewerOutputJsonSchema } from '../../src/schema.js';

/** Walks every object node of a JSON Schema, applying a check to each. */
function eachObjectNode(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => eachObjectNode(n, visit));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const value of Object.values(obj)) eachObjectNode(value, visit);
}

describe('toStrictSchema (codex / OpenAI strict json-schema)', () => {
  const strict = toStrictSchema(reviewerOutputJsonSchema);

  it('forbids extra properties and requires all properties on every object', () => {
    eachObjectNode(strict, (node) => {
      if (node.properties && typeof node.properties === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties as object));
      }
    });
  });

  it('strips validation keywords OpenAI strict mode rejects', () => {
    // findingSchema.fixes carries min(1) → minItems, which must not survive.
    eachObjectNode(strict, (node) => {
      expect(node).not.toHaveProperty('minItems');
      expect(node).not.toHaveProperty('minLength');
      expect(node).not.toHaveProperty('pattern');
      expect(node).not.toHaveProperty('format');
    });
  });

  it('turns a loose additionalProperties:{} into a literal false', () => {
    const loose = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: {},
    };
    expect(toStrictSchema(loose)).toMatchObject({
      additionalProperties: false,
      required: ['a'],
    });
  });

  it('leaves scalar leaves and their types intact', () => {
    expect(toStrictSchema({ type: 'string', description: 'x' })).toEqual({
      type: 'string',
      description: 'x',
    });
  });
});
