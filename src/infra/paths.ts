/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
/**
 * Absolute path of the packaged `gitlab` command: `lib/` once built, `src/infra/` in the
 * source tree tests run from.
 *
 * It lives here rather than in `environment.ts` so `Commands` can run it by path without
 * importing `environment.ts`, which would close a cycle (`environment.ts` → `deployment.ts`
 * → `environment.ts`). Like `gh`'s wrapper, it is run by absolute path, never found through
 * `PATH`: the host's own `PATH` deliberately leaves out the worker shim directory.
 */
/**
 * The optional-env file: operator-written `NAME=value` lines whose names may be
 * credential-shaped, which `Commands` merges into child environments so a skill's
 * CLI (TOS's `ve-tos-cli`, say) can authenticate. Lives beside the other secrets in
 * the state directory's secrets volume, mode 600, never written by dsh-superagent.
 */
export const optionalEnvFile = (): string => '/data/secrets/optional-env'

export const gitlabCli = (): string => {
  const built = join(packageRoot(), 'lib', 'gitlab-cli.sh')
  return existsSync(built) ? built : join(packageRoot(), 'src', 'infra', 'gitlab-cli.sh')
}
