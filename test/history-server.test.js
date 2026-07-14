/**
 * O catálogo ligado ao **servidor de verdade**: um `.scratch/` no disco, um servidor numa
 * porta efêmera, e o log JSONL que sobra do outro lado.
 *
 * O `history.test.js` afirma o que o catálogo *faz* quando alguém o alimenta — aqui se afirma
 * que **o servidor o alimenta**, e que o eixo de tempo é a transição de `Status:`, não o
 * `mtime`: um `.md` reescrito sem mexer no cabeçalho não move uma linha do log, e arquivar um
 * esforço (um `mv` que troca o caminho de todas as issues de uma vez) também não.
 *
 * **Por que este arquivo existe, em vez de o bloco morar no `history.test.js`.** O `HISTORY`
 * do `history.js` é resolvido **no import**, como o `SCRATCHES` do `paths.js` — então plantar
 * `HISTORY_DIR` só vale antes da primeira carga do módulo no processo. O `history.test.js`
 * importa o `createHistory` estaticamente (os testes de unidade de lá passam o `dir` na mão e
 * não se importam), e essa carga congelaria o `HISTORY` no default antes de qualquer teste
 * rodar. Sob o `node --test`, cada arquivo tem o seu processo e o seu registro de módulos: um
 * arquivo à parte, **sem import estático de `src/`**, é o que devolve um catálogo temporário
 * de verdade. É o mesmo motivo por que o `sweep.test.js` e o `namespaces.test.js` moram
 * sozinhos.
 *
 * **E por que o ambiente é plantado uma vez só, e não por teste.** Pela mesma razão, um andar
 * abaixo: o `?boot=` do `import()` renova o `server.js`, mas o `import` que *ele* faz de
 * `./history.js` e `./paths.js` é um especificador sem query — ele bate no módulo já cacheado,
 * e o `HISTORY`/`SCRATCHES` da primeira carga vale para o processo inteiro. Trocar o
 * `HISTORY_DIR` entre os testes não trocaria nada; ele ficaria onde o primeiro `boot()` o
 * fixou. É por isso que o `server.test.js` também planta o ambiente num `before` e compartilha
 * um root com o arquivo todo.
 *
 * O isolamento entre os testes vem, então, de onde ele já existe de graça: **cada teste tem a
 * sua origem**. A chave de todo evento do catálogo é a tripla `(origem, slug, número)`, e um
 * diretório filho do mount é uma origem — logo dois testes não se enxergam no log, mesmo
 * dividindo o arquivo. É a mesma propriedade que o catálogo existe para ter em produção, usada
 * aqui como fixture.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let histDir // o catálogo, um só — como no servidor de verdade
let origens = 0

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'sb-mounts-'))
  histDir = await mkdtemp(join(tmpdir(), 'sb-hist-'))

  // Antes de qualquer `import()`: os três roots são resolvidos no import dos módulos.
  process.env.SCRATCHES_DIR = mounts
  process.env.PADS_DIR = join(mounts, '__pads__')
  process.env.HISTORY_DIR = histDir
})

after(async () => {
  await rm(mounts, { recursive: true, force: true })
  await rm(histDir, { recursive: true, force: true })
})

/** Uma origem só deste teste. O log é comum; a chave de cada evento é que separa. */
async function bootstrap() {
  const ns = `origem${++origens}`
  const root = join(mounts, ns)
  await mkdir(root, { recursive: true })
  return { ns, root }
}

/**
 * As linhas **desta origem**. O log é um só (é o do servidor), e cada evento já diz de onde
 * veio — filtrar por `ns` é ler o que este teste escreveu, e nada mais.
 */
const lines = async (ns) =>
  (await readFile(join(histDir, 'history.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((ev) => ev.ns === ns)

const issueDoc = (title, status) => `Status: ${status}\nType: task\n\n# ${title}\n\nCorpo.\n`

/** Escreve um `.md` do jeito que os agentes escrevem: tmp + rename (atômico). */
async function put(root, rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, body)
  await rename(tmp, path)
}

/** Sobe um servidor novo contra o mesmo disco — é assim que se testa o restart. */
async function boot(t) {
  const { start } = await import(`../src/server.js?boot=${Math.random()}`)
  const s = await start(0, { sweep: 50 })
  t.after(() => s.close())
  return s
}

/** Espera o catálogo ter ao menos `n` linhas desta origem. A varredura curta (50ms) as produz. */
async function until(ns, n) {
  for (let i = 0; i < 100; i++) {
    try {
      const got = await lines(ns)
      if (got.length >= n) return got
    } catch { /* o log ainda não existe */ }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`o catálogo não chegou a ${n} linhas em ${ns}`)
}

test('o servidor registra o ticket que encontra na subida', async (t) => {
  const { ns, root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'ready-for-agent'))

  await boot(t)

  const [ev] = await until(ns, 1)
  assert.equal(ev.kind, 'seen')
  assert.equal(ev.e, 'eixo')
  assert.equal(ev.n, '01')
  assert.equal(ev.status, 'ready-for-agent')
})

test('mudar o Status: vira uma transição no catálogo', async (t) => {
  const { ns, root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'ready-for-agent'))
  await boot(t)
  await until(ns, 1)

  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'claimed'))

  const [, move] = await until(ns, 2)
  assert.equal(move.kind, 'move')
  assert.equal(move.from, 'ready-for-agent')
  assert.equal(move.to, 'claimed')
  assert.ok(move.after < move.before) // a janela fecha, e fecha para a frente
})

test('reescrever o .md sem mudar o Status: não escreve nada — é o caso do Taiga', async (t) => {
  const { ns, root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'resolved'))
  await boot(t)
  await until(ns, 1)

  // O agente fecha uma issue do Taiga e derrama o resultado neste `.md`: o corpo muda, o
  // `mtime` pula, e o `Status:` **não se mexe**. Sob o `mtime`, a barra deste ticket saltaria
  // para hoje. Sob a transição, nada aconteceu — porque nada aconteceu.
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'resolved') + '\n## Resultado\n\nOutra coisa.\n')
  await new Promise((r) => setTimeout(r, 300)) // tempo de sobra para várias varreduras

  assert.equal((await lines(ns)).length, 1)
})

test('a história sobrevive ao restart, e ao arquivamento do esforço', async (t) => {
  const { ns, root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'resolved'))
  const first = await boot(t)
  await until(ns, 1)
  await first.close()

  // Arquivar é um `mv`: o caminho de toda issue do esforço muda de uma vez.
  await mkdir(join(root, 'archive'), { recursive: true })
  await rename(join(root, 'eixo'), join(root, 'archive', 'eixo'))

  await boot(t)
  await new Promise((r) => setTimeout(r, 300))

  // Nenhuma linha nova: a chave é a tripla `(origem, slug, número)`, e ela não se mexeu.
  // Com chave por caminho, o esforço inteiro reapareceria como se tivesse nascido agora —
  // e esforço arquivado é justamente o esforço terminado que o Gantt existe para medir.
  const got = await lines(ns)
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'seen')
})

test('o board serializado não ganhou campo nenhum', async (t) => {
  const { root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'ready-for-agent'))
  const s = await boot(t)

  const board = await (await fetch(`http://127.0.0.1:${s.port}/api/board`)).text()
  // O catálogo é estado do **servidor**. Ele não atravessa o fio neste ticket — quem o
  // consome é o 03 (o rótulo) e o 04 (o Gantt). Um campo instável no payload mata o push.
  assert.doesNotMatch(board, /mtime/)
  assert.doesNotMatch(board, /"since"/)
  assert.doesNotMatch(board, /"alive"/)
})

test('o catálogo é best-effort: a escrita dele falhando não derruba o board nem o processo', async (t) => {
  const { ns, root } = await bootstrap()
  await put(root, 'eixo/issues/01-um.md', issueDoc('Um', 'ready-for-agent'))

  // Torna a escrita do catálogo impossível, do jeito mais direto e determinístico: o caminho
  // de `history.jsonl` vira um **diretório**. O `observe()` estoura `EISDIR` no `appendFile`
  // toda vez que o board é lido — o mesmo formato de falha que um disco cheio ou um volume
  // remontado `ro` produziriam.
  const log = join(histDir, 'history.jsonl')
  await rm(log, { recursive: true, force: true })
  await mkdir(log)

  const s = await boot(t)

  // O board já tinha sido lido com sucesso quando o `observe()` falhou. `/api/board` serve o
  // board de verdade, não o `400` de uma escrita que não é dele.
  const res = await fetch(`http://127.0.0.1:${s.port}/api/board`)
  assert.equal(res.status, 200)
  const b = (await res.json()).boards[ns]
  assert.equal(b.efforts.find((e) => e.slug === 'eixo')?.total, 1)

  // E o processo continua de pé: uma segunda leitura, depois da falha do catálogo, ainda
  // responde — nada derrubou o servidor inteiro.
  const again = await fetch(`http://127.0.0.1:${s.port}/api/board`)
  assert.equal(again.status, 200)
})
