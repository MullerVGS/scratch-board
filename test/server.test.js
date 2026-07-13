/**
 * O servidor de verdade, contra um `.scratch/` de verdade.
 *
 * Esta é a costura mais alta do projeto e a que cobre mais: sobe o servidor numa **porta
 * efêmera** apontando para um diretório temporário, abre o stream SSE com o `fetch` nativo
 * e **escreve arquivos no disco** — arquivos mesmo, não mocks de `fs`. O que se afirma é o
 * que chega pelo fio.
 *
 * É aqui que a promessa central do push vira teste. Não basta o servidor conseguir emitir:
 * ele tem que emitir **quando** e **só quando** o board mudou.
 *
 *   - escrita empurra;
 *   - escrita sem mudança semântica **não** empurra (a supressão por hash);
 *   - rajada de seis arquivos vira **um** evento (o debounce);
 *   - diretório novo aparece sem reiniciar nada;
 *   - fechar um ticket que bloqueia outro **desbloqueia** o outro no board empurrado.
 *
 * E o `/shared/doc.js`: um teste de unidade nunca o pegaria — a rede do parser roda no
 * filesystem, não pela HTTP. Se aquela rota morrer, o `md.js` do browser falha no import,
 * e um import de módulo falha **em silêncio**: o board simplesmente não monta. A rota só é
 * defensável por HTTP, e é por isso que ela é testada aqui.
 *
 * Os roots do board saem do ambiente (`SCRATCH_DIR`, `PADS_DIR`) e o `paths.js` os resolve
 * no import — daí o `import()` dinâmico depois de plantar o ambiente.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root // o `.scratch/` temporário
let pads
let server
let base

/** Escreve um arquivo, criando o diretório se preciso. */
async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status, extra = '') =>
  `Status: ${status}\nType: task\n${extra}\n# ${title}\n\nUm corpo qualquer.\n`

/**
 * O stream SSE, lido com o `fetch` nativo — sem `EventSource` (que é do browser) e sem
 * biblioteca. Um frame é o texto até a linha em branco; só as linhas `data: ` interessam.
 */
async function openStream() {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queue = []
  let wake = null
  let buf = ''

  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          if (!data) continue // `retry:` e os `: ping` não são eventos
          queue.push(JSON.parse(data))
          wake?.()
          wake = null
        }
      }
    } catch { /* abortado no fim do teste */ }
  })()

  const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

  const stream = {
    /** O próximo evento, ou explode no timeout. */
    async next(ms = 4000) {
      const deadline = Date.now() + ms
      while (!queue.length) {
        if (Date.now() > deadline) throw new Error('o servidor não empurrou nada')
        await Promise.race([new Promise((ok) => (wake = ok)), nap(50)])
      }
      return queue.shift()
    },
    /** Afirma que **nada** chega em `ms`. É a supressão virando asserção. */
    async silence(ms = 700) {
      await nap(ms)
      assert.deepEqual(queue, [], 'o servidor empurrou um evento que não devia existir')
    },
    /** Quantos eventos chegaram em `ms`. É o debounce virando asserção. */
    async count(ms = 700) {
      await nap(ms)
      return queue.length
    },
    drain: () => queue.splice(0, queue.length),
    close: () => ac.abort(),
  }

  await stream.next() // o snapshot de conexão
  return stream
}

const get = (path) => fetch(`${base}${path}`)
const board = async () => (await get('/api/board')).json()
const effortOf = (b, slug) => b.efforts.find((e) => e.slug === slug)

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'board-scratch-'))
  pads = await mkdtemp(join(tmpdir(), 'board-pads-'))
  process.env.SCRATCH_DIR = root
  process.env.PADS_DIR = pads

  await put('alpha/map.md', '# Mapa do alpha\n\nO primeiro parágrafo.\n')
  await put('alpha/issues/01-um.md', issue('01 — Um', 'resolved'))
  await put('alpha/issues/02-dois.md', issue('02 — Dois', 'ready-for-agent'))

  // Depois do ambiente, nunca antes: o `paths.js` resolve os roots no import.
  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(root, { recursive: true, force: true })
  await rm(pads, { recursive: true, force: true })
})

test('/api/board projeta o disco', async () => {
  const b = await board()
  const alpha = effortOf(b, 'alpha')
  assert.equal(alpha.title, 'Mapa do alpha')
  assert.equal(alpha.total, 2)
  assert.equal(alpha.closed, 1)
})

test('effort.mtime não está no payload — o carimbo que mataria a supressão saiu', async () => {
  const b = await board()
  const alpha = effortOf(b, 'alpha')
  assert.equal('mtime' in alpha, false)
  // E não é só o esforço: nada do board carrega carimbo de filesystem.
  assert.equal(JSON.stringify(b).includes('mtime'), false)
})

test('escrever um .md empurra um board novo, e ele reflete a mudança', async () => {
  const stream = await openStream()
  try {
    await put('alpha/issues/02-dois.md', issue('02 — Dois', 'resolved'))

    const { board: pushed, changed } = await stream.next()
    const alpha = effortOf(pushed, 'alpha')
    assert.equal(alpha.closed, 2)
    assert.equal(alpha.archivable, true)
    assert.ok(
      changed.some((p) => p.endsWith('02-dois.md')),
      'o evento carrega os caminhos que mexeram — é o que a gaveta viva vai consultar',
    )
  } finally {
    stream.close()
  }
})

test('reescrever um arquivo com o mesmo conteúdo NÃO empurra nada', async () => {
  const same = issue('02 — Dois', 'resolved')
  const stream = await openStream()
  try {
    await put('alpha/issues/02-dois.md', same)
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('tocar um arquivo (mtime novo, conteúdo igual) NÃO empurra nada', async () => {
  const stream = await openStream()
  try {
    const now = new Date()
    await utimes(join(root, 'alpha/issues/02-dois.md'), now, now)
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('um arquivo que o board não projeta (.swp) NÃO empurra nada', async () => {
  const stream = await openStream()
  try {
    // Ele mexe no `mtime` do diretório do esforço — que é exatamente o campo que saiu do
    // payload. Se ele voltasse, este teste falharia, e a supressão seria decoração.
    await put('alpha/issues/.02-dois.md.swp', 'lixo de editor')
    await rm(join(root, 'alpha/issues/.02-dois.md.swp'))
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('uma rajada de seis escritas vira UM evento, não seis', async () => {
  const stream = await openStream()
  try {
    for (let n = 1; n <= 6; n++) {
      await put(`rajada/issues/0${n}-t.md`, issue(`0${n} — T`, 'ready-for-agent'))
    }

    const events = await stream.count(900)
    assert.equal(events, 1, `o debounce falhou: ${events} eventos para uma rajada`)

    const { board: pushed } = await stream.next()
    assert.equal(effortOf(pushed, 'rajada').total, 6)
  } finally {
    stream.close()
  }
})

test('um esforço novo — diretório que não existia quando o servidor subiu — aparece sem reiniciar nada', async () => {
  const stream = await openStream()
  try {
    await put('nasceu-agora/PRD.md', '# Esforço recém-nascido\n\nExiste agora.\n')

    const { board: pushed } = await stream.next()
    const novo = effortOf(pushed, 'nasceu-agora')
    assert.ok(novo, 'o watch recursivo não pegou o diretório novo')
    assert.equal(novo.title, 'Esforço recém-nascido')
  } finally {
    stream.close()
  }
})

test('fechar um ticket que bloqueia outro desbloqueia o outro no board empurrado', async () => {
  await put('bloqueio/issues/01-base.md', issue('01 — Base', 'ready-for-agent'))
  await put(
    'bloqueio/issues/02-preso.md',
    issue('02 — Preso', 'ready-for-agent', 'Blocked by: 01 — a base tem que existir antes'),
  )

  const antes = effortOf(await board(), 'bloqueio')
  const preso = antes.issues.find((i) => i.number === '02')
  assert.equal(preso.blocked, true)
  // O contrato do payload (ticket 02): `{ number, note, raw }`, e nada mais.
  assert.deepEqual(Object.keys(preso.blockedBy[0]).sort(), ['note', 'number', 'raw'])
  assert.equal(preso.blockedBy[0].number, '01')
  // A nota é tudo que vem depois do número, como o autor escreveu — travessão incluído.
  assert.equal(preso.blockedBy[0].note, '— a base tem que existir antes')

  const stream = await openStream()
  try {
    await put('bloqueio/issues/01-base.md', issue('01 — Base', 'resolved'))

    const { board: pushed } = await stream.next()
    const depois = effortOf(pushed, 'bloqueio')
    assert.equal(depois.issues.find((i) => i.number === '02').blocked, false)
    assert.equal(depois.issues.find((i) => i.number === '01').closed, true)
  } finally {
    stream.close()
  }
})

test('/api/file recusa um caminho fora dos roots', async () => {
  const fora = await get('/api/file?path=/etc/passwd')
  assert.equal(fora.status, 400)
  assert.match((await fora.json()).error, /fora dos diretórios permitidos/)

  const traversal = await get(`/api/file?path=${encodeURIComponent(join(root, '../../etc/passwd'))}`)
  assert.equal(traversal.status, 400)

  const vazio = await get('/api/file?path=')
  assert.equal(vazio.status, 400)
})

test('/api/file lê um arquivo de dentro do root', async () => {
  const res = await get(`/api/file?path=${encodeURIComponent(join(root, 'alpha/map.md'))}`)
  assert.equal(res.status, 200)
  assert.match((await res.json()).content, /Mapa do alpha/)
})

test('o board é servível: /, /app.js e o /shared/doc.js que o browser importa', async () => {
  // O `md.js` do browser faz `import ... from '../shared/doc.js'` — que na URL vira
  // `/shared/doc.js`. Se essa rota morrer num corte, o import falha **em silêncio** e o
  // board não monta. Nenhum teste de unidade percebe: a rede do parser roda no filesystem.
  for (const [path, type] of [
    ['/', /text\/html/],
    ['/app.js', /javascript/],
    ['/md.js', /javascript/],
    ['/router.js', /javascript/],
    ['/shared/doc.js', /javascript/],
  ]) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} não respondeu 200`)
    assert.match(res.headers.get('content-type'), type, `${path} veio com o tipo errado`)
  }

  const doc = await (await get('/shared/doc.js')).text()
  assert.match(doc, /export function parseDoc/, 'o /shared/doc.js não é o parser')

  // E o estático não escapa do seu root.
  assert.equal((await get('/shared/../src/server.js')).status, 404)
})
