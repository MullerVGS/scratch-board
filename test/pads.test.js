/**
 * Os scratchpads de sessão: o que a travessia **poda**, e o que ela não tem o direito de podar.
 *
 * O root dos pads sai do ambiente (`PADS_DIR`), e o `paths.js` o resolve **no import** — daí
 * o `import()` dinâmico depois de plantar o ambiente, como no `server.test.js`. O `PADS_REF`
 * fica no default de propósito: o `ref` que o humano cola é `/tmp/claude-0/...`, e é ele que
 * está sob teste, não um valor inventado pelo teste.
 *
 * **O que este arquivo afirma é o contrato, não o custo.** Que os descendentes de um
 * `node_modules` nunca sejam *percorridos* é uma propriedade de desempenho, e desempenho não
 * se afirma numa suíte que roda numa máquina compartilhada — ele foi **medido**, e o número
 * vive na resposta do ticket (935ms → 0,6ms; 14.404 arquivos → 4). Aqui se afirma o que sai
 * pelo fio: **nada de dentro de um `node_modules`, em profundidade nenhuma, alcança o
 * payload** — nem como arquivo, nem como contagem, nem como byte, nem como recência.
 *
 * A recência é a asserção mais afiada das quatro, e por isso ela existe separada: o
 * `pad.mtime` é o **máximo** dos mtimes dos arquivos, então um arquivo recém-tocado dentro do
 * `node_modules` sequestraria a ordem da lista inteira e o "há N min" do card. Se um dia a
 * poda for "simplificada" para um filtro depois da travessia, é este teste que fica vermelho.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pads // o root dos scratchpads: cada filho é uma sessão
let listPads

/** Escreve um arquivo sob `<sessao>/scratchpad/`, criando os diretórios do caminho. */
async function put(session, rel, body = 'rascunho\n') {
  const path = join(pads, session, 'scratchpad', rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

/** Os nomes dos arquivos de uma sessão, como o card os lista. */
const namesOf = (pad) => pad.files.map((f) => f.name).sort()

const bySession = (list, session) => list.find((p) => p.session === session)

before(async () => {
  pads = await mkdtemp(join(tmpdir(), 'pads-'))
  process.env.PADS_DIR = pads
  ;({ listPads } = await import('../src/pads.js'))
})

after(async () => {
  await rm(pads, { recursive: true, force: true })
})

test('poda o `node_modules` em qualquer profundidade, e o vizinho recursivo sobrevive', async () => {
  await put('sessao-a', 'notas.md')
  await put('sessao-a', 'sub/analise.py') // vizinho recursivo: um nível abaixo, e continua visível
  await put('sessao-a', 'node_modules/pkg/index.js') // podado: no topo do scratchpad
  await put('sessao-a', 'sub/node_modules/dep/lib/deep.js') // podado: **aninhado**, dois níveis abaixo

  const pad = bySession(await listPads(), 'sessao-a')

  assert.deepEqual(namesOf(pad), ['notas.md', 'sub/analise.py'])
  const todos = pad.files.map((f) => f.path).join('\n')
  assert.ok(!todos.includes('node_modules'), 'nenhum caminho de dentro de um node_modules escapou')
})

test('as contagens e os bytes ignoram o que foi podado', async () => {
  await put('sessao-b', 'plano.md', 'x'.repeat(100))
  await put('sessao-b', 'node_modules/pkg/grande.js', 'y'.repeat(50_000))

  const pad = bySession(await listPads(), 'sessao-b')

  assert.equal(pad.files.length, 1, 'o card conta só o que a sessão rascunhou')
  assert.equal(pad.bytes, 100, 'os 50 KB do node_modules não entram na soma')
})

test('a recência não vem do que foi podado', async () => {
  const draft = await put('sessao-c', 'notas.md')
  const dep = await put('sessao-c', 'node_modules/pkg/index.js')

  // O arquivo podado é o **mais recente** de longe. Se a travessia o alcançasse, ele
  // sequestraria o `mtime` do card (que é o máximo) e a ordem da lista.
  const velho = new Date('2020-01-01T00:00:00Z')
  const novo = new Date('2030-01-01T00:00:00Z')
  await utimes(draft, velho, velho)
  await utimes(dep, novo, novo)

  const pad = bySession(await listPads(), 'sessao-c')

  assert.equal(pad.mtime, velho.getTime(), 'a recência é a do rascunho, não a da dependência')
})

test('uma sessão que só deixou `node_modules` não deixou nada', async () => {
  await put('sessao-d', 'node_modules/pkg/index.js')

  const lista = await listPads()

  // Sessão sem arquivo nenhum já era omitida. Com a poda, uma sessão cujo scratchpad é
  // *só* dependência instalada passa a ser exatamente isso: uma sessão que não rascunhou.
  assert.equal(bySession(lista, 'sessao-d'), undefined)
})

test('a poda é de **diretório**, não de nome: um arquivo chamado `node_modules` é conteúdo', async () => {
  await put('sessao-g', 'node_modules', 'isto é um rascunho, não uma árvore de dependências\n')

  const pad = bySession(await listPads(), 'sessao-g')

  // O `PRUNED` só é consultado no ramo do diretório. Um arquivo comum que por acaso tem esse
  // nome é o que a sessão escreveu, e some-lo seria o board mentindo sobre o disco.
  //
  // Este teste também é o que separa a poda de verdade — feita **na travessia** — de um
  // filtro por nome aplicado depois de andar a árvore inteira: o filtro derruba este arquivo
  // junto, e paga os 935ms que a poda existe para não pagar. (O custo em si não se afirma
  // aqui: ele foi medido, e o número está na resposta do ticket.)
  assert.deepEqual(namesOf(pad), ['node_modules'])
})

test('o `ref` é o caminho absoluto real, colável de qualquer cwd', async () => {
  await put('sessao-e', 'sub/drive.mjs')

  const pad = bySession(await listPads(), 'sessao-e')

  // O board lê por `path` (dentro do container); o humano copia `ref`. Um `ref` com
  // `/workspace/` dentro não leva a lugar nenhum.
  assert.equal(pad.files[0].ref, '/tmp/claude-0/-root-projetos/sessao-e/scratchpad/sub/drive.mjs')
  assert.equal(pad.ref, '/tmp/claude-0/-root-projetos/sessao-e/scratchpad')
})

test('sob demanda: o arquivo que nasce e o que some aparecem na releitura seguinte', async () => {
  await put('sessao-f', 'primeiro.md')
  assert.deepEqual(namesOf(bySession(await listPads(), 'sessao-f')), ['primeiro.md'])

  // Sem watcher e sem push: quem relê é a tela, ao entrar ou pelo botão. `listPads()` é a
  // releitura inteira — não há cache a invalidar, e é por isso que os pads podem ser
  // preguiçosos sem mentir.
  const morto = await put('sessao-f', 'segundo.md')
  assert.deepEqual(namesOf(bySession(await listPads(), 'sessao-f')), ['primeiro.md', 'segundo.md'])

  await rm(morto)
  assert.deepEqual(namesOf(bySession(await listPads(), 'sessao-f')), ['primeiro.md'])
})
