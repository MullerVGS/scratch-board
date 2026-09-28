/**
 * As chaves temporárias da API de escrita, contra um `keys.json` de verdade num diretório
 * temporário. O que se afirma é o ciclo que o humano faz pelo CLI — emitir, listar, revogar — e
 * o que a API pergunta a cada requisição: esta chave vale, e para quais origens.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createKeyStore, parseTtl } from '../src/keys.js'

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'keys-')) })
after(() => rm(dir, { recursive: true, force: true }))

test('emitida, a chave vale para as origens dela e o arquivo guarda só o hash', async () => {
  const store = createKeyStore(join(dir, 'a'))
  const { id, token, expiresAt } = await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'teste' })
  assert.match(token, /^sk_[0-9a-f]{8}_[A-Za-z0-9_-]+$/)
  assert.ok(token.startsWith(`sk_${id}_`))
  assert.ok(Date.parse(expiresAt) > Date.now())

  const check = await store.verify(token)
  assert.equal(check.ok, true)
  assert.deepEqual(check.key.origins, ['pessoal'])
  assert.equal(check.key.label, 'teste')

  const raw = await readFile(join(dir, 'a', 'keys.json'), 'utf8')
  assert.ok(!raw.includes(token.split('_')[2]), 'o segredo nunca vai ao disco')
})

test('segredo errado, id inexistente e formato torto não valem', async () => {
  const store = createKeyStore(join(dir, 'b'))
  const { id } = await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'x' })
  for (const bad of [`sk_${id}_errado`, 'sk_00000000_abc', 'lixo', '', undefined]) {
    const check = await store.verify(bad)
    assert.equal(check.ok, false, String(bad))
    assert.equal(check.reason, 'token inválido')
  }
})

test('expirada diz que expirou', async () => {
  const store = createKeyStore(join(dir, 'c'))
  const { token } = await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'x', now: Date.now() - 2 * 3600e3 })
  const check = await store.verify(token)
  assert.equal(check.ok, false)
  assert.equal(check.reason, 'token expirado')
})

test('revogar uma e revogar todas', async () => {
  const store = createKeyStore(join(dir, 'd'))
  const a = await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'a' })
  const b = await store.issue({ origins: ['*'], ttl: '1h', label: 'b' })
  assert.equal((await store.list()).length, 2)

  assert.equal(await store.revoke(a.id), 1)
  assert.equal((await store.verify(a.token)).ok, false)
  assert.equal((await store.verify(b.token)).ok, true)

  assert.equal(await store.revoke('--all'), 1)
  assert.equal((await store.verify(b.token)).ok, false)
  assert.deepEqual(await store.list(), [])
})

test('ttl: formatos aceitos, teto de 7 dias', () => {
  assert.equal(parseTtl('30m'), 30 * 60e3)
  assert.equal(parseTtl('24h'), 24 * 3600e3)
  assert.equal(parseTtl('7d'), 7 * 86400e3)
  assert.throws(() => parseTtl('8d'), /7 dias/)
  assert.throws(() => parseTtl('amanhã'), /ttl/)
})

test('CLI: issue imprime o token uma vez, list não o mostra, revoke apaga', async () => {
  const run = promisify(execFile)
  const env = { ...process.env, STATE_DIR: join(dir, 'cli') }
  const cli = (...args) => run(process.execPath, ['src/keys.js', ...args], { env, cwd: join(import.meta.dirname, '..') })

  const { stdout: issued } = await cli('issue', '--origins', 'pessoal', '--ttl', '2h', '--label', 'cli')
  const token = /sk_\S+/.exec(issued)[0]
  const id = token.split('_')[1]

  const { stdout: listed } = await cli('list')
  assert.match(listed, new RegExp(id))
  assert.match(listed, /cli/)
  assert.ok(!listed.includes(token))

  await cli('revoke', id)
  const { stdout: after } = await cli('list')
  assert.ok(!after.includes(id))
})
