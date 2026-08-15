import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Validates the local registry metadata examples.
 *
 * Publishing artefacts are optional on purpose: this repository publishes no npm package and hosts
 * no public remote, so advertising either would be untrue. Placeholder hosts and versions are
 * rejected so a copied template cannot ship pretending to be published.
 */

const placeholder = /(example\.com|example\.invalid|replace\.invalid|replace-me|changeme)/iu;

const repository = z.object({ url: z.url(), source: z.literal('github') });

const serverSchema = z.object({
  $schema: z.url().optional(),
  name: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9._-]+$/),
  description: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  repository,
  /** Only present once a package is genuinely published. */
  packages: z
    .array(
      z.object({
        registryType: z.enum(['npm', 'oci', 'pypi', 'nuget', 'mcpb']),
        identifier: z.string().min(1),
        version: z.string().min(1),
        transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']) }),
      }),
    )
    .min(1)
    .optional(),
  /** Only present once a public endpoint genuinely exists. */
  remotes: z
    .array(z.object({ type: z.literal('streamable-http'), url: z.url() }))
    .min(1)
    .optional(),
});

const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const assertNoPlaceholders = (path: string, value: unknown): void => {
  if (placeholder.test(JSON.stringify(value))) {
    throw new Error(`${path} still contains a placeholder value`);
  }
};

const serverMetadata = await load('server.json');
assertNoPlaceholders('server.json', serverMetadata);
const server = serverSchema.parse(serverMetadata);

const registryEntry = await load('examples/central-registry-entry.json');
assertNoPlaceholders('examples/central-registry-entry.json', registryEntry);
registrySchema.parse(registryEntry);

const packageJson = (await load('package.json')) as { version: string };
if (packageJson.version !== server.version) {
  throw new Error(
    `server.json version ${server.version} does not match package.json ${packageJson.version}`,
  );
}

process.stdout.write('Metadata examples are valid.\n');
