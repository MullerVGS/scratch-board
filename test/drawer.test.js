/**
 * Os contratos de que a **gaveta viva** depende — e que não moram nela.
 *
 * A gaveta é DOM puro (`public/drawer.js`) e não há harness de DOM neste projeto: zero
 * dependências, e um `jsdom` seria a primeira. O que ela *faz* — trocar o conteúdo
 * preservando a rolagem — só se prova dirigindo o navegador de verdade, não aqui.
 *
 * O que se prova **aqui** é o que a gaveta *assume* sobre o mundo, porque é isso que
 * pode mudar debaixo dela sem ninguém perceber:
 *
 *   1. que o `changed` do push traz o caminho **byte-a-byte igual** ao `path` que o board
 *      publica — é uma comparação direta (`changed.includes(current.path)`), sem
 *      tradução, e uma barra a mais de um lado a mataria em silêncio;
 *   2. que remover o arquivo aberto **chega** à gaveta como um push com o caminho dele;
 *   3. que o `/api/file` de um arquivo removido responde com a mensagem que a gaveta
 *      procura para dizer "sumiu" — se ela mudar, a gaveta volta a vomitar um erro cru,
 *      e nenhum outro teste percebe.
 *
 * Os três são silenciosos ao quebrar. É por isso que são testes.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts
let root
let pads
let server
let base

const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

/** O stream SSE lido com o `fetch` nativo — o `EventSource` é do browser. */
async function openStream() {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queue = []
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
          if (data) queue.push(JSON.parse(data))
        }
      }
    } catch { /* abortado no fim do teste */ }
  })()

  const stream = {
    async next(ms = 4000) {
      const deadline = Date.now() + ms
      while (!queue.length) {
        if (Date.now() > deadline) throw new Error('o servidor não empurrou nada')
        await nap(30)
      }
      return queue.shift()
    },
    close: () => ac.abort(),
  }

  await stream.next() // o snapshot de conexão
  return stream
}

const issue = (title, status) => `Status: ${status}\nType: task\n\n# ${title}\n\nUm corpo qualquer.\n`

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-drawer-'))
  root = join(mounts, 'projetos')
  await mkdir(root, { recursive: true })
  pads = await mkdtemp(join(tmpdir(), 'board-drawer-pads-'))
  process.env.SCRATCHES_DIR = mounts
  process.env.PADS_DIR = pads

  await put('vivo/map.md', '# Mapa do vivo\n\nO primeiro parágrafo.\n')
  await put('vivo/issues/01-aberta.md', issue('01 — A que está aberta na gaveta', 'claimed'))

  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
  await rm(pads, { recursive: true, force: true })
})

const boardOf = async () => (await (await fetch(`${base}/api/board`)).json()).boards.projetos
const openIssue = async () =>
  (await boardOf()).efforts.find((e) => e.slug === 'vivo').issues.find((i) => i.number === '01')

test('o `changed` do push fala o mesmo vocabulário de caminho que o board — comparação direta, sem tradução', async () => {
  // É a asserção que sustenta a linha `changed.includes(current.path)` do `drawer.js`. O
  // `current.path` vem do `issue.path` do board; o `changed` vem do `fs.watch`. São dois
  // caminhos calculados em lugares diferentes, e a gaveta os compara com `===`.
  const aberta = await openIssue()

  const stream = await openStream()
  try {
    await put('vivo/issues/01-aberta.md', issue('01 — A que está aberta na gaveta', 'resolved'))

    const { changed } = await stream.next()
    assert.ok(
      changed.includes(aberta.path),
      `o caminho do push não bate com o do board:\n  board: ${aberta.path}\n  push:  ${changed.join(', ')}`,
    )
  } finally {
    stream.close()
  }
})

test('remover o arquivo aberto chega à gaveta: o push traz o caminho dele no `changed`', async () => {
  await put('vivo/issues/02-condenada.md', issue('02 — Vai sumir', 'ready-for-agent'))
  await nap(300)

  const condenada = (await boardOf()).efforts
    .find((e) => e.slug === 'vivo')
    .issues.find((i) => i.number === '02')
  assert.ok(condenada, 'a issue condenada precisa existir antes de sumir')

  const stream = await openStream()
  try {
    await rm(condenada.path)

    const { changed, board } = await stream.next()
    assert.ok(
      changed.includes(condenada.path),
      'a gaveta nunca saberia que o arquivo aberto sumiu',
    )
    // E o board empurrado já não a projeta — some da lista e some da gaveta, no mesmo evento.
    const ainda = board.efforts.find((e) => e.slug === 'vivo').issues.find((i) => i.number === '02')
    assert.equal(ainda, undefined)
  } finally {
    stream.close()
  }
})

test('o esforço diz de que origem veio e onde mora — os dois campos com que a gaveta se acha', async () => {
  // Com uma origem só, a gaveta podia perguntar "o board"; com N, ela tem que perguntar
  // **qual**. O `freshOpts()` recalcula a moldura contra `state.boards[effort.ns]`, e o
  // `wireRefs()` resolve um link relativo contra `effort.path`. Os dois vêm do servidor, e
  // se qualquer um sumir do payload a gaveta procura o esforço no board errado — que, com
  // slugs repetidos entre origens, é o jeito de **achar** o esforço errado.
  const vivo = (await boardOf()).efforts.find((e) => e.slug === 'vivo')

  assert.equal(vivo.ns, 'projetos')
  assert.equal(vivo.path, join(root, 'vivo'))
  // E o `path` do esforço é o prefixo do `path` das issues dele: é essa igualdade que faz o
  // `${effort.path}/${doc.name}` do `effort.js` cair no arquivo certo.
  assert.ok(vivo.issues[0].path.startsWith(`${vivo.path}/`))
})

test('o /api/file de um arquivo removido responde a mensagem que a gaveta procura para dizer "sumiu"', async () => {
  const fantasma = join(root, 'vivo/issues/99-nunca-existiu.md')
  const res = await fetch(`${base}/api/file?path=${encodeURIComponent(fantasma)}`)

  assert.equal(res.status, 404)
  const { error } = await res.json()

  // O `drawer.js` compara a mensagem com uma constante sua (`MISSING`) para separar
  // "sumiu do disco" — um fato do mundo, que ele sabe dizer com uma frase — de um erro
  // qualquer, que ele só sabe repetir. Se o servidor trocar esta string, a gaveta volta a
  // mostrar um erro cru, **em silêncio**: nada mais no projeto olha para ela.
  const drawer = await readFile(new URL('../public/drawer.js', import.meta.url), 'utf8')
  const declarada = /const MISSING = '([^']+)'/.exec(drawer)?.[1]

  assert.ok(declarada, 'o drawer.js não declara mais a constante MISSING')
  assert.equal(
    error,
    declarada,
    `o /api/file responde "${error}" e a gaveta procura "${declarada}" — ela nunca vai dizer que o arquivo sumiu`,
  )
})
