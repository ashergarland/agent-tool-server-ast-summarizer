import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serverInstructions } from '../../src/tools/guidance.js';
import { createToolRegistry } from '../../src/tools/registry.js';

const fixtureSchema = z.object({
  requiredCategories: z.array(z.string().min(1)).min(1),
  scenarios: z
    .array(
      z.object({
        id: z.string().min(1),
        category: z.string().min(1),
        request: z.string().min(1),
        expectedTools: z.array(z.string().min(1)),
        rationale: z.string().min(1),
        guidanceSignals: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

const fixtures = fixtureSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/routing.json', import.meta.url), 'utf8')),
);

const registry = createToolRegistry();
const toolNames = new Set(registry.list().map((tool) => tool.name));
const publishedText = [
  serverInstructions,
  ...registry.list().map((tool) => `${tool.summary} ${tool.description}`),
  ...registry.list().map((tool) => JSON.stringify(tool.inputJsonSchema)),
]
  .join('\n')
  .toLowerCase();

describe('routing fixtures', () => {
  it('uses unique identifiers and covers every required category', () => {
    const ids = fixtures.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(fixtures.scenarios.map((scenario) => scenario.category));
    for (const required of fixtures.requiredCategories) {
      expect(categories).toContain(required);
    }
  });

  it('references only tools this server actually registers', () => {
    for (const scenario of fixtures.scenarios) {
      for (const tool of scenario.expectedTools) {
        expect(toolNames, `${scenario.id} expects an unknown tool`).toContain(tool);
      }
    }
  });

  it('publishes the routing signal every scenario depends on', () => {
    for (const scenario of fixtures.scenarios) {
      for (const signal of scenario.guidanceSignals) {
        expect(publishedText, `${scenario.id} needs the signal "${signal}"`).toContain(
          signal.toLowerCase(),
        );
      }
    }
  });

  it('keeps catalogue text informative but bounded', () => {
    expect(serverInstructions.length).toBeLessThan(2_000);
    for (const tool of registry.list()) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(tool.description.length).toBeLessThan(1_200);
      for (const required of ['use', 'do not use', 'prerequisite', 'limitation', 'read-only']) {
        expect(tool.description.toLowerCase()).toContain(required);
      }
    }
  });

  it('describes every input field an agent must supply', () => {
    for (const tool of registry.list()) {
      const schema = tool.inputJsonSchema as {
        properties?: Record<string, { description?: string }>;
      };
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description, `${tool.name}.${name} has no description`).toBeTruthy();
      }
    }
  });
});
