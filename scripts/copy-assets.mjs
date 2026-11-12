/** Copies packaged shell commands next to the built bundle so they are callable at their published paths. */
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'

const ASSETS = [['src/infra/gitlab-cli.sh', 'lib/gitlab-cli.sh']]

mkdirSync('lib', { recursive: true })
for (const [source, target] of ASSETS) {
  copyFileSync(source, target)
  chmodSync(target, 0o755)
}
