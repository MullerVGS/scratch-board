/**
 * A API de leitura e escrita (`src/api.js`) de verdade, numa porta efêmera, contra origens de
 * verdade num diretório temporário. Duas origens montadas — `pessoal` e `zapizi` — e chaves
 * emitidas pela mesma loja que o CLI usa.
 *
 * O que se afirma é o que chega pelo fio **e o que fica no disco**: uma escrita recusada não
 * deixa byte nenhum, dentro ou fora da raiz.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { startApi } from '../src/api.js'
import { createKeyStore } from '../src/keys.js'

let tmp, repos, state, outside, server, base, token, tokenAll, tokenExpired

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

const call = (method, path, { auth = token, headers = {}, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    body,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
  })

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'api-'))
  repos = join(tmp, 'repos')
  state = join(tmp, 'state')
  outside = join(tmp, 'fora')
  await mkdir(join(repos, 'pessoal', '.scratch', 'notinhas'), { recursive: true })
  await mkdir(join(repos, 'zapizi', '.scratch'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(repos, 'pessoal', '.scratch', 'notinhas', '01.md'), 'Status: ready-for-agent\n\n# Primeiro\n')
  await writeFile(join(repos, 'zapizi', '.scratch', 'segredo.md'), '# da empresa\n')
  await writeFile(join(outside, 'alvo.md'), 'original\n')
  await symlink(outside, join(repos, 'pessoal', '.scratch', 'fuga'))

  const store = createKeyStore(state)
  token = (await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'teste' })).token
  tokenAll = (await store.issue({ origins: ['*'], ttl: '1h', label: 'tudo' })).token
  tokenExpired = (await store.issue({ origins: ['pessoal'], ttl: '1h', label: 'velha', now: Date.now() - 2 * 3600e3 })).token

  server = await startApi(0, { reposDir: repos, stateDir: state, folders: '' })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server?.close()
  await rm(tmp, { recursive: true, force: true })
})

// ---------- autenticação e escopo ----------

test('sem token, token torto ou expirado: 401 dizendo qual', async () => {
  let r = await call('GET', '/api/origins', { auth: null })
  assert.equal(r.status, 401)
  assert.match((await r.json()).error, /ausente/)

  r = await call('GET', '/api/origins', { auth: 'sk_00000000_x' })
  assert.equal(r.status, 401)
  assert.match((await r.json()).error, /inválido/)

  r = await call('GET', '/api/origins', { auth: tokenExpired })
  assert.equal(r.status, 401)
  assert.match((await r.json()).error, /expirado/)
})

test('atrás da borda: token em X-Scratch-Token, com o Authorization ocupado pelo Basic do Pangolin', async () => {
  const r = await call('GET', '/api/origins', {
    auth: null,
    headers: { authorization: 'Basic c2NyYXRjaDpzZWdyZWRv', 'x-scratch-token': token },
  })
  assert.equal(r.status, 200)
  const bad = await call('GET', '/api/origins', { auth: null, headers: { authorization: 'Basic c2NyYXRjaDpzZWdyZWRv' } })
  assert.equal(bad.status, 401)
  assert.match((await bad.json()).error, /ausente/)
})

test('healthz responde sem token', async () => {
  const r = await call('GET', '/healthz', { auth: null })
  assert.equal(r.status, 200)
})

test('origins lista só as da chave', async () => {
  assert.deepEqual((await (await call('GET', '/api/origins')).json()).map((o) => o.name), ['pessoal'])
  assert.deepEqual((await (await call('GET', '/api/origins', { auth: tokenAll })).json()).map((o) => o.name), ['pessoal', 'zapizi'])
})

test('origem fora da chave: 403 em leitura e escrita; inexistente com *: 404', async () => {
  assert.equal((await call('GET', '/api/tree?ns=zapizi')).status, 403)
  assert.equal((await call('GET', '/api/file?ns=zapizi&path=segredo.md')).status, 403)
  const w = await call('PUT', '/api/file?ns=zapizi&path=novo.md', { headers: { 'if-none-match': '*' }, body: 'x' })
  assert.equal(w.status, 403)
  assert.deepEqual(await readdir(join(repos, 'zapizi', '.scratch')), ['segredo.md'])
  assert.equal((await call('GET', '/api/tree?ns=nada', { auth: tokenAll })).status, 404)
})

// ---------- leitura ----------

test('tree é a árvore do board, sem o caminho do container', async () => {
  const r = await call('GET', '/api/tree?ns=pessoal')
  assert.equal(r.status, 200)
  const board = await r.json()
  const text = JSON.stringify(board)
  assert.ok(!text.includes(repos), 'caminho interno não vaza')
  const dir = board.tree.find((n) => n.name === 'notinhas')
  const file = dir.children.find((n) => n.name === '01.md')
  assert.equal(file.rel, 'notinhas/01.md')
  assert.equal(file.status, 'ready-for-agent')
  assert.equal(file.title, 'Primeiro')
})

test('file devolve o corpo cru e o ETag sha1', async () => {
  const r = await call('GET', '/api/file?ns=pessoal&path=notinhas/01.md')
  assert.equal(r.status, 200)
  const body = await r.text()
  assert.equal(body, 'Status: ready-for-agent\n\n# Primeiro\n')
  assert.equal(r.headers.get('etag'), `"${sha1(body)}"`)
  assert.equal((await call('GET', '/api/file?ns=pessoal&path=notinhas/99.md')).status, 404)
})

// ---------- escrita ----------

test('cria com If-None-Match: *, com subpasta nova; de novo dá 412', async () => {
  const body = 'Status: needs-triage\n\n# Novo\n'
  let r = await call('PUT', '/api/file?ns=pessoal&path=novo/sub/02.md', { headers: { 'if-none-match': '*' }, body })
  assert.equal(r.status, 201)
  assert.equal((await r.json()).etag, sha1(body))
  assert.equal(await readFile(join(repos, 'pessoal', '.scratch', 'novo', 'sub', '02.md'), 'utf8'), body)

  r = await call('PUT', '/api/file?ns=pessoal&path=novo/sub/02.md', { headers: { 'if-none-match': '*' }, body: 'outro' })
  assert.equal(r.status, 412)
  assert.equal(await readFile(join(repos, 'pessoal', '.scratch', 'novo', 'sub', '02.md'), 'utf8'), body)
})

test('edita com If-Match certo; ETag velho dá 412 e o arquivo fica intacto', async () => {
  const path = '/api/file?ns=pessoal&path=notinhas/01.md'
  const current = await (await call('GET', path)).text()
  const next = current.replace('ready-for-agent', 'resolved')

  let r = await call('PUT', path, { headers: { 'if-match': `"${sha1(current)}"` }, body: next })
  assert.equal(r.status, 200)

  r = await call('PUT', path, { headers: { 'if-match': sha1(current) }, body: 'atropelo' })
  assert.equal(r.status, 412)
  assert.equal(await readFile(join(repos, 'pessoal', '.scratch', 'notinhas', '01.md'), 'utf8'), next)
})

test('PUT sem precondição: 428; If-Match em arquivo que não existe: 412', async () => {
  assert.equal((await call('PUT', '/api/file?ns=pessoal&path=x.md', { body: 'x' })).status, 428)
  assert.equal((await call('PUT', '/api/file?ns=pessoal&path=x.md', { headers: { 'if-match': 'abc' }, body: 'x' })).status, 412)
})

test('escrita atômica: nenhum temporário sobra na pasta', async () => {
  await call('PUT', '/api/file?ns=pessoal&path=atom/a.md', { headers: { 'if-none-match': '*' }, body: 'a' })
  assert.deepEqual(await readdir(join(repos, 'pessoal', '.scratch', 'atom')), ['a.md'])
})

test('contenção: .., absoluto, oculto e symlink para fora são recusados sem gravar nada', async () => {
  const attempts = [
    '../../fora/alvo.md',
    '..%2F..%2Ffora%2Falvo.md',
    `${outside}/alvo.md`,
    'fuga/alvo.md',
    'fuga/novo.md',
    '.git/config.md',
  ]
  for (const p of attempts) {
    const r = await call('PUT', `/api/file?ns=pessoal&path=${p}`, { headers: { 'if-none-match': '*' }, body: 'pwned' })
    assert.equal(r.status, 400, p)
    const g = await call('GET', `/api/file?ns=pessoal&path=${p}`)
    assert.equal(g.status, 400, `GET ${p}`)
  }
  assert.deepEqual(await readdir(outside), ['alvo.md'])
  assert.equal(await readFile(join(outside, 'alvo.md'), 'utf8'), 'original\n')
})

test('só texto: extensão fora da lista dá 415; corpo acima de 1 MB dá 413', async () => {
  const r = await call('PUT', '/api/file?ns=pessoal&path=x.sh', { headers: { 'if-none-match': '*' }, body: 'x' })
  assert.equal(r.status, 415)
  const big = 'a'.repeat(1024 * 1024 + 1)
  const b = await call('PUT', '/api/file?ns=pessoal&path=grande.md', { headers: { 'if-none-match': '*' }, body: big })
  assert.equal(b.status, 413)
  assert.equal((await call('GET', '/api/file?ns=pessoal&path=grande.md')).status, 404)
})

test('audit.log: uma linha por escrita, com chave, caminho e hashes', async () => {
  const log = (await readFile(join(state, 'audit.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  const edit = log.find((l) => l.path === 'pessoal/notinhas/01.md')
  assert.equal(edit.label, 'teste')
  assert.equal(edit.op, 'update')
  assert.match(edit.before, /^[0-9a-f]{40}$/)
  assert.match(edit.after, /^[0-9a-f]{40}$/)
  assert.ok(log.some((l) => l.op === 'create' && l.path === 'pessoal/novo/sub/02.md' && l.before === null))
  assert.ok(!log.some((l) => l.path.includes('fora')), 'recusa não é escrita')
})
