import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [directory, commit] = process.argv.slice(2)
if (!directory || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A build directory and exact commit are required')
const hash = name => createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')
writeFileSync(join(directory, 'release.json'), JSON.stringify({
  commit,
  localOnly: true,
  site: 'https://wu-zzz.github.io/opengym-local/',
  indexSha256: hash('index.html'),
  swSha256: hash('sw.js')
}) + '\n')
writeFileSync(join(directory, '.nojekyll'), '')
