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

test('observations() devolve a sequência de status observados, cada um com o instante em que entrou nele', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)
  await h.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 2000)
  await h.observe('projetos', [effort('eixo', ['01', 'claimed'])], 3000)
  await h.observe('projetos', [effort('eixo', ['01', 'resolved'])], 5000)

  // Cada linha do Gantt é uma issue; cada faixa dela é uma coluna. O `at` de um status é o
  // instante em que o servidor **confirmou** aquele estado — o `before` da transição —, e é o
  // limite esquerdo da faixa daquela coluna. Ninguém afirma um instante que não viu.
  const obs = h.observations('projetos', 'eixo', '01')
  assert.deepEqual(obs, [
    { status: 'ready-for-agent', at: new Date(1000).toISOString() },
    { status: 'claimed', at: new Date(3000).toISOString() },
    { status: 'resolved', at: new Date(5000).toISOString() },
  ])
})

test('observations() de um ticket que o catálogo nunca viu é uma lista vazia, não uma exceção', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = await createHistory(dir)
  assert.deepEqual(h.observations('projetos', 'eixo', '99'), [])
})

test('a sequência observada sobrevive à subida — o Gantt a relê do log', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = await createHistory(dir)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)
  await first.observe('projetos', [effort('eixo', ['01', 'claimed'])], 3000)

  const second = await createHistory(dir)
  assert.deepEqual(second.observations('projetos', 'eixo', '01'), [
    { status: 'ready-for-agent', at: new Date(1000).toISOString() },
    { status: 'claimed', at: new Date(3000).toISOString() },
  ])
})

test('arquivo `alive` com data inválida é descartado silenciosamente, não lança', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Primeira instância escreve o batimento.
  const first = await createHistory(dir)
  await first.observe('projetos', [effort('eixo', ['01', 'ready-for-agent'])], 1000)

  // Corrompe o arquivo `alive` para uma string inválida.
  const beat = join(dir, 'alive')
  await writeFile(beat, JSON.stringify({ at: 'lixo' }) + '\n')

  // Segunda instância relê o arquivo corrompido. Deve descartar e resultar em `alive = null`.
  const second = await createHistory(dir)
  assert.equal(second.alive, null)

  // Uma transição agora não deve lançar `RangeError`. Como `alive` é `null`,
  // a janela `after` da transição deve ser `null` (não sabemos desde quando).
  await assert.doesNotReject(() => second.observe('projetos', [effort('eixo', ['01', 'claimed'])], 5000))

  // Verifica que a transição foi registrada com a janela correta.
  const [, move] = await lines(dir)
  assert.equal(move.kind, 'move')
  assert.equal(move.after, null) // inválido descartado ⇒ sem limite inferior
  assert.equal(move.before, new Date(5000).toISOString())
})
