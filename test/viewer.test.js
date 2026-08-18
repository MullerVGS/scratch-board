/**
 * Os contratos de que o **viewer ao vivo** depende — e que não moram nele.
 *
 * O viewer é DOM puro (`public/viewer.js`) e não há harness de DOM neste projeto: zero
 * dependências, e um `jsdom` seria a primeira. O que ele *faz* — trocar o conteúdo
 * preservando a rolagem, acender o realce, subir o âmbar do sumiço — só se prova dirigindo o
 * navegador de verdade, não aqui.
 *
 * O que se prova **aqui** é o que o viewer *assume* sobre o mundo, porque é isso que pode
 * mudar debaixo dele sem ninguém perceber:
 *
 *   1. que o `changed` do push traz o caminho **byte-a-byte igual** ao `path` que o board
 *      publica — é uma comparação direta (`changed.includes(current.path)`), sem tradução, e
 *      uma barra a mais de um lado a mataria em silêncio;
 *   2. que remover o arquivo aberto **chega** ao viewer como um push com o caminho dele;
 *   3. que o `/api/file` de um arquivo removido responde, **em texto cru**, a mensagem que a
 *      constante `MISSING` do viewer procura — se qualquer uma das duas mudar, o viewer volta
 *      a vomitar um erro cru, e nenhum outro teste percebe;
 *   4. que o nó de arquivo carrega `path` (o que ele lê) e `ref` (o que ele copia), nos dois
 *      vocabulários certos.
 *
 * Todos são silenciosos ao quebrar. É por isso que são testes.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let root // o `.scratch/` da origem `projetos`
let server
let base

const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status) => `Status: ${status}\nType: task\n\n# ${title}\n\nUm corpo qualquer.\n`

/**
 * O stream SSE lido com o `fetch` nativo — o `EventSource` é do browser. Guarda o nome do
 * evento junto do payload: `message` carrega a árvore (+ `changed`); `files` carrega só os
 * caminhos que mexeram no disco.
 */
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
          const lines = frame.split('\n')
          const data = lines
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          if (!data) continue
          const named = lines.find((l) => l.startsWith('event: '))
          queue.push({ event: named ? named.slice(7) : 'message', ...JSON.parse(data) })
        }
      }
    } catch {
      /* abortado no fim do teste */
    }
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

  await stream.next() // o snapshot de conexão (uma origem, um frame)
  return stream
}

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-viewer-'))
  root = join(mounts, 'projetos', '.scratch')
  await mkdir(root, { recursive: true })
  process.env.REPOS_DIR = mounts

  await put('vivo/map.md', '# Mapa do vivo\n\nO primeiro parágrafo.\n')
  await put('vivo/issues/01-aberta.md', issue('01 — A que está aberta no viewer', 'claimed'))

  // Depois do ambiente, nunca antes: o `paths.js` resolve os roots no import.
  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
})

/** A projeção da origem `projetos`: `{ ns, root, ref, tree }`. */
const board = async () => (await fetch(`${base}/api/board?ns=projetos`)).json()

/** Acha um nó pelo nome, em qualquer profundidade — a árvore não é plana. */
function find(nodes, name) {
  for (const n of nodes) {
    if (n.name === name) return n
    if (n.children) {
      const hit = find(n.children, name)
      if (hit) return hit
    }
  }
  return null
}

const openNode = async () => find((await board()).tree, '01-aberta.md')

test('o `changed` do push fala o mesmo vocabulário de caminho que o board — comparação direta, sem tradução', async () => {
  // É a asserção que sustenta a linha `changed.includes(current.path)` do `viewer.js`. O
  // `current.path` vem do `node.path` do board; o `changed` vem do `fs.watch`. São dois
  // caminhos calculados em lugares diferentes, e o viewer os compara com `===`.
  const aberta = await openNode()

  const stream = await openStream()
  try {
    await put('vivo/issues/01-aberta.md', issue('01 — A que está aberta no viewer', 'resolved'))

    const { changed } = await stream.next()
    assert.ok(
      changed.includes(aberta.path),
      `o caminho do push não bate com o do board:\n  board: ${aberta.path}\n  push:  ${changed.join(', ')}`,
    )
  } finally {
    stream.close()
  }
})

test('remover o arquivo aberto chega ao viewer: o push traz o caminho dele no `changed`', async () => {
  await put('vivo/issues/02-condenada.md', issue('02 — Vai sumir', 'ready-for-agent'))
  await nap(300)

  const condenada = find((await board()).tree, '02-condenada.md')
  assert.ok(condenada, 'a issue condenada precisa existir antes de sumir')

  const stream = await openStream()
  try {
    await rm(condenada.path)

    const { changed, board: pushed } = await stream.next()
    assert.ok(changed.includes(condenada.path), 'o viewer nunca saberia que o arquivo aberto sumiu')
    // E o board empurrado já não a projeta — some da árvore e some do viewer, no mesmo evento.
    assert.equal(find(pushed.tree, '02-condenada.md'), null)
  } finally {
    stream.close()
  }
})

test('o /api/file de um arquivo removido responde, em texto cru, a mensagem que o viewer procura', async () => {
  const fantasma = join(root, 'vivo/issues/99-nunca-existiu.md')
  const res = await fetch(`${base}/api/file?path=${encodeURIComponent(fantasma)}`)

  assert.equal(res.status, 404)
  // **Corpo cru**, não envelope: o viewer o exibe direto, e compara byte-a-byte com `MISSING`.
  assert.match(res.headers.get('content-type'), /text\/plain/)
  const body = await res.text()

  const viewer = await readFile(new URL('../public/viewer.js', import.meta.url), 'utf8')
  const declarada = /const MISSING = '([^']+)'/.exec(viewer)?.[1]

  assert.ok(declarada, 'o viewer.js não declara mais a constante MISSING')
  assert.equal(
    body,
    declarada,
    `o /api/file responde "${body}" e o viewer procura "${declarada}" — ele nunca vai dizer que o arquivo sumiu`,
  )
  // O caso do enunciado: traduzir uma sem a outra devolve o erro cru.
  assert.equal(declarada, 'não encontrado')
})

test('o nó de arquivo carrega `path` (o que o viewer lê) e `ref` (o que ele copia), nos dois vocabulários', async () => {
  // O viewer recebe `showFile(container, ns, node)`: `ns` é a chave da origem em
  // `state.boards`, `node.path` é por onde ele busca o conteúdo, `node.ref` é o que ele
  // copia. Se qualquer um vazar o vocabulário errado, o viewer lê o arquivo errado — ou
  // copia um caminho que não existe do cwd de quem cola.
  const b = await board()
  assert.equal(b.ns, 'projetos', 'a origem é a chave que o viewer usa em state.boards[ns]')

  const aberta = await openNode()
  assert.equal(aberta.type, 'file')
  // `path` é o caminho de leitura (container); `ref`, o do workspace — e o container nunca
  // vaza para o `ref`.
  assert.equal(aberta.path, join(root, 'vivo/issues/01-aberta.md'))
  assert.equal(aberta.ref, '.scratch/vivo/issues/01-aberta.md')
  assert.equal(aberta.ref.includes(mounts), false, 'o caminho do container nunca vira o `ref` copiável')
  // `rel` é a chave de rota — é dela que o `app.js` acha o nó que manda ao viewer.
  assert.equal(aberta.rel, 'vivo/issues/01-aberta.md')
})
