/**
 * O catálogo: o que o servidor lembra depois de morrer.
 *
 * O log é a única coisa deste projeto que **sobrevive ao processo**, então o que se afirma
 * aqui é justamente o que um teste de unidade em memória não pegaria: que a história é
 * relida, que uma linha truncada não leva as outras junto, e que a janela de uma transição
 * observada através de um restart é a janela honesta — do batimento até agora.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHistory } from '../src/history.js'

/** Um esforço no formato que o `buildBoard()` produz — só o que o catálogo olha. */
const effort = (slug, ...issues) => ({
  slug,
  issues: issues.map(([number, status]) => ({ number, status })),
})

const lines = async (dir) =>
  (await readFile(join(dir, 'history.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

test('o primeiro encontro com um ticket vira uma linha, e ela diz o status', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)

  const [ev] = await lines(dir)
  assert.equal(ev.kind, 'seen')
  assert.equal(ev.src, 'medido')
  assert.equal(ev.ns, 'projetos')
  assert.equal(ev.e, 'eixo')
  assert.equal(ev.n, '01')
  assert.equal(ev.status, 'ready-for-agent')
  assert.equal(ev.at, new Date(1000).toISOString())
})

test('ver o mesmo status de novo não escreve nada', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  const board = [effort('eixo', ['01', 'ready-for-agent'])]
  await h.observe('projetos', board, 1000)
  await h.observe('projetos', board, 2000)
  await h.observe('projetos', board, 3000)

  assert.equal((await lines(dir)).length, 1)
})

test('a transição vira uma linha com a janela entre as duas observações', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 2000)
  await h.observe('projetos', [effort('eixo', ['01', 'claimed'])], 3000)

  const [, move] = await lines(dir)
  assert.equal(move.kind, 'move')
  assert.equal(move.from, 'ready-for-agent')
  assert.equal(move.to, 'claimed')
  // A janela é do **último instante em que vi o status velho** até agora — não do
  // nascimento do ticket. Ninguém afirma um instante que não viu.
  assert.equal(move.after, new Date(2000).toISOString())
  assert.equal(move.before, new Date(3000).toISOString())
})

test('a história é relida na subida: um catálogo novo já sabe o que o anterior viu', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = await createHistory(dir)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)

  const second = await createHistory(dir)
  assert.equal(second.of('projetos', 'eixo', '01').status, 'ready-for-agent')

  // E não reescreve o que já sabia: observar o mesmo status não soma linha.
  await second.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 5000)
  assert.equal((await lines(dir)).length, 1)
})

test('a janela através de um restart vai do batimento até agora — não do nascimento', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = await createHistory(dir)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 9000) // último batimento

  // O servidor morreu aqui. Sobe de novo, e o ticket já está em `claimed`.
  const second = await createHistory(dir)
  assert.equal(second.alive, new Date(9000).toISOString())
  await second.observe('projetos', [effort('eixo', ['01', 'claimed'])], 12000)

  const [, move] = await lines(dir)
  assert.equal(move.after, new Date(9000).toISOString()) // o último instante em que estive vivo
  assert.equal(move.before, new Date(12000).toISOString())
})

test('uma linha truncada não leva a história junto', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = await createHistory(dir)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)

  // O `append` foi interrompido: meia linha no fim do arquivo.
  const log = join(dir, 'history.jsonl')
  await writeFile(log, (await readFile(log, 'utf8')) + '{"kind":"move","fr')

  const second = await createHistory(dir)
  assert.equal(second.of('projetos', 'eixo', '01').status, 'ready-for-agent')
})

test('a origem entra na chave: dois esforços de slug igual não se fundem', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)
  await h.observe('pos', [effort('eixo', ['01', 'resolved'])], 1000)

  assert.equal(h.of('projetos', 'eixo', '01').status, 'ready-for-agent')
  assert.equal(h.of('pos', 'eixo', '01').status, 'resolved')
})

test('o ticket nunca visto tem limite inferior desconhecido, e o board não inventa um', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)

  const { since } = h.of('projetos', 'eixo', '01')
  assert.equal(since.after, null) // não sei desde quando — e digo isso
  assert.equal(since.before, new Date(1000).toISOString())
})
