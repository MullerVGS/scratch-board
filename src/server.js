// Só HTTP: rotas, estáticos, o stream SSE e a contenção dos caminhos que chegam do cliente.
//
// O que o board *é* mora ao lado — `board.js` monta a projeção do `.scratch/`, `pads.js`
// lê os scratchpads, `cache.js` guarda o board e decide se ele mudou, `watch.js` escuta o
// disco, `../shared/doc.js` entende o dialeto dos `.md`. Aqui só se responde.
//
// O board **não pergunta mais** ao disco a cada 5 segundos: ele é avisado. O watcher emite,
// o cache suprime o que não mudou, e o que sobra desce por `/api/stream` para quem estiver
// olhando — o board inteiro, num evento, calculado num lugar só. Um diff foi rejeitado
// porque exigiria uma máquina de merge no cliente, que pode divergir do disco: é
// exatamente o pecado que o board existe para não cometer.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

import { SCRATCH, PADS } from './paths.js'
import { listPads } from './pads.js'
import { refresh, current } from './cache.js'
import { watchTree } from './watch.js'

const PORT = Number(process.env.PORT ?? 7777)
const PUBLIC = resolve(import.meta.dirname, '..', 'public')
// O parser que o browser também importa. É servido estático, sob o mesmo prefixo que o
// `import` do `md.js` escreve (`../shared/doc.js`), para que o especificador resolva
// igual nos dois lados: no filesystem, para o Node; na URL, para o browser.
const SHARED = resolve(import.meta.dirname, '..', 'shared')

/** Um arquivo grande ou binário não vai para a gaveta; só o fato de existir importa. */
const TEXT_LIMIT = 512 * 1024

/** Um comentário SSE de tempos em tempos: mantém o socket vivo e denuncia o que morreu. */
const PING_MS = 30_000

/** Prende um `path` vindo do cliente aos roots que o board pode ler. */
function safePath(input) {
  const p = resolve(input)
  const ok = [SCRATCH, PADS].some((r) => p === r || p.startsWith(r + sep))
  if (!ok) throw new Error('caminho fora dos diretórios permitidos')
  return p
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// ---------- o push ----------

/** Quem está com o board aberto. Um `res` de SSE que nunca termina. */
const clients = new Set()

// O board já está serializado; reparsear para reserializar dentro de um envelope seria
// pagar 62 KB de JSON duas vezes por evento. O envelope é montado como texto.
//
// `changed` é a lista de caminhos que mexeram no disco (vazia no snapshot de conexão). O
// board não precisa dela — ele vem inteiro —, mas a gaveta precisa: é assim que ela
// descobre que o documento aberto é justamente o que o agente acabou de escrever.
const frame = (json, changed) => `data: {"changed":${JSON.stringify(changed)},"board":${json}}\n\n`

function broadcast(json, changed) {
  const payload = frame(json, changed)
  for (const res of clients) res.write(payload)
}

/**
 * Relê o disco e empurra — **se, e só se, o board mudou**.
 *
 * É o único caminho que emite. Serve tanto o watcher quanto o `/api/board`: uma releitura
 * por HTTP que descobre uma mudança também avisa as outras abas, em vez de guardar a
 * novidade para si e deixar o hash mentir para o resto do mundo.
 */
async function sync(changed = []) {
  const { json, changed: moved } = await refresh()
  if (moved) broadcast(json, changed)
  return json
}

// ---------- as rotas ----------

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/api/board') return send(res, 200, await sync())

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      // O snapshot de conexão. É ele que cura o restart do container sem F5: o
      // `EventSource` reconecta sozinho e o servidor devolve o board inteiro.
      res.write(`retry: 2000\n\n`)
      res.write(frame((await current()).json, []))
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
      const drop = () => {
        clearInterval(ping)
        clients.delete(res)
      }
      req.on('close', drop)
      res.on('close', drop)
      return
    }

    if (url.pathname === '/api/pads') return send(res, 200, { root: PADS, pads: await listPads() })

    if (url.pathname === '/api/file') {
      const path = safePath(url.searchParams.get('path') ?? '')
      const { size } = await stat(path)
      if (size > TEXT_LIMIT) {
        return send(res, 200, { path, content: `— arquivo de ${size} bytes, grande demais para exibir —` })
      }
      const buf = await readFile(path)
      // NUL nos primeiros bytes é o sinal barato de binário: evita despejar um PNG na gaveta.
      const binary = buf.subarray(0, 8000).includes(0)
      return send(res, 200, {
        path,
        content: binary ? `— binário, ${size} bytes —` : buf.toString('utf8'),
      })
    }

    // Estático de dois roots: `public/` na raiz da URL, e `shared/` sob `/shared/` — é
    // por ali que o `md.js` do browser importa o parser que o servidor também usa.
    const [root, file] = url.pathname.startsWith('/shared/')
      ? [SHARED, url.pathname.slice('/shared/'.length)]
      : [PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)]
    const path = resolve(root, file)
    if (!path.startsWith(root + sep)) return send(res, 403, { error: 'proibido' })
    return send(res, 200, await readFile(path, 'utf8'), MIME[extname(path)] ?? 'text/plain')
  } catch (err) {
    const missing = err.code === 'ENOENT'
    send(res, missing ? 404 : 400, { error: missing ? 'não encontrado' : err.message })
  }
}

/**
 * Sobe o servidor e liga o watcher nele.
 *
 * Porta `0` pede uma porta efêmera ao sistema — é assim que o teste de integração sobe um
 * board de verdade contra um `.scratch/` temporário sem brigar com o container que já roda
 * na 7777.
 */
export function start(port = PORT) {
  const server = createServer(handler)
  const unwatch = watchTree(SCRATCH, (paths) => {
    sync(paths).catch(() => { /* o disco piscou; a varredura de segurança repesca */ })
  })

  return new Promise((ok) => {
    server.listen(port, () => {
      ok({
        server,
        port: server.address().port,
        close: async () => {
          unwatch()
          for (const res of clients) res.end()
          clients.clear()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

// `node src/server.js` sobe o servidor; `import` (dos testes) só pega o `start`, e é o
// teste que escolhe a porta. Sem o guard, `node --test` levantaria a 7777 e penduraria.
const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename

if (isMain) {
  const { port } = await start()
  console.log(`scratch-board em http://localhost:${port}  (vigiando ${SCRATCH})`)
}
