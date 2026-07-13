/**
 * O watcher — e sobretudo o que ele faz quando **falha**.
 *
 * O modo de falha de um sistema de push é o silêncio, e um watcher morto é silêncio
 * perfeito: nenhum erro na tela, nenhum log, nenhuma diferença visível de "nada mudou".
 * Ele é a peça do board que mais barato tem de morrer calada, e por isso é a que mais
 * precisa provar que não morre.
 *
 * O debounce e o watch recursivo já são exercitados contra o disco pelo
 * `server.test.js` (rajada de seis, diretório novo). O que sobra aqui é o **reopen**:
 *
 *   - `fs.watch` que estoura no `open` (o root não existe) — ele volta quando o root nasce;
 *   - `fs.watch` que emite `error` depois de aberto — ele reabre e volta a entregar evento.
 *
 * O primeiro roda contra o disco de verdade. O segundo não tem como: apagar o root **não**
 * emite `error` (verificado — o kernel manda `rename` e cala), e não existe forma de fora
 * de fazer um watcher vivo errar. Daí o `open` injetável do `watchTree`: um watcher de
 * mentira que erra sob comando é a única maneira de essa linha ser afirmada em vez de
 * prometida. O que ele substitui é o `fs.watch`, e nada mais — o debounce, o reopen e o
 * ciclo de vida testados são os de produção.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchTree } from '../src/watch.js'

const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** Um `fs.watch` de mentira: entrega os eventos que o teste mandar, inclusive `error`. */
function fakeWatch() {
  const opened = []
  const open = () => {
    const w = new EventEmitter()
    w.close = () => { w.closed = true }
    w.closed = false
    opened.push(w)
    return w
  }
  // A assinatura do `fs.watch`: (root, opts, listener) → watcher.
  const fn = (_root, _opts, listener) => {
    const w = open()
    w.fire = (name) => listener('change', name)
    return w
  }
  return { fn, opened, last: () => opened[opened.length - 1] }
}

test('um watcher que emite `error` é reaberto, e volta a entregar eventos', async () => {
  const fake = fakeWatch()
  const bursts = []
  const stop = watchTree('/qualquer/root', (paths) => bursts.push(paths), {
    debounce: 20,
    retry: 60,
    open: fake.fn,
  })

  try {
    assert.equal(fake.opened.length, 1, 'não abriu o watch')

    // O watcher morre. Se ninguém o reabrisse, o board ficaria mostrando dados velhos
    // com cara de vivos — para sempre, e sem uma linha de log.
    fake.last().emit('error', new Error('inotify morreu'))
    await nap(160)

    assert.equal(fake.opened.length, 2, 'o watch não foi reestabelecido — morreu em silêncio')
    assert.equal(fake.opened[0].closed, true, 'o watcher morto não foi fechado')

    // E o novo watcher está de fato ligado no `onChange` — reabrir sem religar o fio
    // seria a mesma morte, com mais passos.
    fake.last().fire('alpha/issues/01.md')
    await nap(60)

    assert.equal(bursts.length, 1, 'o watch reaberto não entrega evento')
    assert.deepEqual(bursts[0], [join('/qualquer/root', 'alpha/issues/01.md')])
  } finally {
    stop()
  }
})

test('o reopen para quando o watch é encerrado — não fica um timer batendo em nada', async () => {
  const fake = fakeWatch()
  const stop = watchTree('/qualquer/root', () => {}, { debounce: 20, retry: 60, open: fake.fn })

  fake.last().emit('error', new Error('morreu'))
  stop() // encerrado no meio da espera do retry

  await nap(160)
  assert.equal(fake.opened.length, 1, 'reabriu um watch depois de encerrado')
})

test('root que ainda não existe: o watch não morre — ele espera o root nascer', async () => {
  // Contra o disco de verdade. `fs.watch` estoura ENOENT aqui, e o caminho de erro é o
  // mesmo do `error`: em vez de propagar e matar o watcher, ele tenta de novo.
  const home = await mkdtemp(join(tmpdir(), 'board-watch-'))
  const root = join(home, 'ainda-nao-existe')
  const bursts = []
  const stop = watchTree(root, (paths) => bursts.push(paths), { debounce: 40, retry: 80 })

  try {
    await nap(60)
    await mkdir(root, { recursive: true })

    // Dá tempo de o retry pegar o root recém-nascido, e então escreve nele.
    await nap(220)
    await writeFile(join(root, 'chegou.md'), '# chegou\n')

    const deadline = Date.now() + 3000
    while (!bursts.length && Date.now() < deadline) await nap(50)

    assert.ok(bursts.length, 'o watch desistiu do root que não existia e nunca mais voltou')
    assert.ok(bursts.flat().some((p) => p.endsWith('chegou.md')))
  } finally {
    stop()
    await rm(home, { recursive: true, force: true })
  }
})
