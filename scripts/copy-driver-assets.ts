/** Build-time only: retain attribution and pinned provenance in distributed lib. */
import { copyFile, mkdir } from 'node:fs/promises'
const target = new URL('../lib/driver/', import.meta.url)
await mkdir(target, {recursive: true})
for (const name of ['UPSTREAM-LICENSE.txt', 'provenance.json']) {
  await copyFile(new URL('../src/driver/' + name, import.meta.url), new URL(name, target))
}
