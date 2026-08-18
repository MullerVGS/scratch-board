/**
 * A projeção de **árvore genérica** — o coração do novo board.
 *
 * O board deixou de exigir a estrutura de um esforço (PRD, map, issues, status): ele projeta
 * **o que houver** no `.scratch/`, arquivo por arquivo, pasta por pasta. `buildTree(ns)` é
 * "leia o disco agora": sem cache, sem catálogo, sem colunas. O que se afirma aqui é a forma
 * do que ele devolve.
 *
 * As garantias que mais importam são silenciosas ao quebrar:
 *
 *   - a **ordem** é por `mtime` desc, com desempate alfabético **estável** — uma flutuação no
 *     empate moveria o hash da supressão sem ninguém escrever nada (um push fantasma);
 *   - a pasta herda a **recência do filho** (o `mtime` da pasta é o máximo recursivo), então um
 *     save fundo reordena a árvore inteira até a raiz — o que faz o trabalho quente subir;
 *   - `status`/`título` só entram quando o `.md` os tem, e **nunca** como `undefined`
 *     serializado — campo instável no payload mata o push;
 *   - entrada oculta nunca é projetada.
 *
 * Contra um `.scratch/` de verdade, escrito com `fs` e envelhecido com `utimes` — não há
 * relógio a mockar, o tempo se fabrica no disco.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTree, errorTree } from '../src/tree.js'

let root // o `.scratch/` da origem de teste
let ns

/** Escreve um arquivo sob o root, criando o que faltar. */
async function put(rel, body = '') {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

/** Envelhece um arquivo no disco — o tempo se fabrica, não se mocka. */
async function age(rel, days) {
  const when = new Date(Date.now() - days * 864e5)
  await utimes(join(root, rel), when, when)
}

const mtimeOf = async (rel) => (await stat(join(root, rel))).mtimeMs

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

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'tree-'))
  // A origem de casa: `ref` nu. É o que o `refIn` usa para qualificar cada nó.
  ns = { name: 't', root, ref: '.scratch' }
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('ordena por mtime desc; a pasta herda a recência do filho', async () => {
  await put('a/old.md', '# Velho\n')
  await put('b/new.md', '# Novo\n')
  await age('a/old.md', 7) // a é mais antiga
  const recente = await mtimeOf('b/new.md')

  const { tree } = await buildTree(ns)

  // A pasta com o arquivo mais novo abre a árvore.
  assert.equal(tree[0].name, 'b', 'a pasta com o filho mais recente tem que vir primeiro')
  // E ela herda o `mtime` do filho — o máximo recursivo, não o do diretório em si.
  assert.equal(tree[0].mtime, recente, 'a pasta tem que herdar o mtime do filho mais novo')
  assert.equal(tree.at(-1).name, 'a', 'a pasta antiga afunda para o fim')
})

test('empate de mtime cai na ordem alfabética estável do readdir', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-tie-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    // Três arquivos com o **mesmo** mtime: o desempate é o único critério que sobra, e ele
    // tem que ser determinístico — senão o hash flutua sem ninguém escrever.
    const same = new Date(Date.now() - 3600e3)
    for (const name of ['banana.txt', 'abacaxi.txt', 'caju.txt']) {
      await writeFile(join(t, name), 'x')
      await utimes(join(t, name), same, same)
    }
    const { tree } = await buildTree(local)
    assert.deepEqual(
      tree.map((n) => n.name),
      ['abacaxi.txt', 'banana.txt', 'caju.txt'],
      'no empate, a ordem tem que ser alfabética e estável',
    )
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('arquivo genérico entra sem selo; .md com Status: ganha selo e título', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-selo-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await writeFile(join(t, 'notes.txt'), 'texto solto, sem cabeçalho')
    await writeFile(join(t, 'um.md'), 'Status: ready-for-agent\n# Título\n\nCorpo.\n')

    const { tree } = await buildTree(local)

    const txt = find(tree, 'notes.txt')
    assert.equal(txt.type, 'file')
    assert.equal('status' in txt, false, 'arquivo genérico não pode carregar status')
    assert.equal('title' in txt, false, 'arquivo genérico não pode carregar título')

    const md = find(tree, 'um.md')
    assert.equal(md.status, 'ready-for-agent')
    assert.equal(md.title, 'Título')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('.md sem Status: não inventa selo — nada de `status: undefined` serializado', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-nostatus-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await writeFile(join(t, 'so-titulo.md'), '# Só um título\n\nsem cabeçalho de status\n')
    await writeFile(join(t, 'vazio.md'), 'texto sem título nem status\n')

    const { tree } = await buildTree(local)
    const so = find(tree, 'so-titulo.md')
    assert.equal(so.title, 'Só um título')
    assert.equal('status' in so, false)

    const vazio = find(tree, 'vazio.md')
    assert.equal('status' in vazio, false)
    assert.equal('title' in vazio, false)

    // E o guarda do fio: nenhum `undefined` viaja no JSON.
    assert.equal(JSON.stringify(tree).includes('undefined'), false)
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('status desconhecido passa por normalizeStatus (o `?` do vocabulário novo)', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-norm-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await writeFile(join(t, 'x.md'), 'Status: inventado\n# X\n')
    const { tree } = await buildTree(local)
    assert.equal(find(tree, 'x.md').status, '?inventado')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('não exige estrutura: pasta sem PRD/map/issues projeta o que houver', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-livre-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await writeFile(join(t, 'solto.log'), 'só um log solto')
    const { tree } = await buildTree(local)
    assert.equal(tree.length, 1)
    assert.equal(tree[0].name, 'solto.log')
    assert.equal(tree[0].type, 'file')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('oculto não é projetado', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-hidden-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await writeFile(join(t, '.oculto'), 'lixo de editor')
    await writeFile(join(t, 'visivel.md'), '# Visível\n')
    // E oculto fundo também não: um `.git/` dentro não pode vazar arquivo nenhum.
    await mkdir(join(t, '.git'), { recursive: true })
    await writeFile(join(t, '.git/config'), '[core]\n')

    const { tree } = await buildTree(local)
    assert.equal(tree.length, 1, 'só o visível pode aparecer')
    assert.equal(tree[0].name, 'visivel.md')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('pasta vazia vale mtime 0 e afunda', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-empty-dir-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await mkdir(join(t, 'oca'), { recursive: true })
    await writeFile(join(t, 'com-arquivo.md'), '# Tem conteúdo\n')

    const { tree } = await buildTree(local)
    const oca = find(tree, 'oca')
    assert.equal(oca.type, 'dir')
    assert.equal(oca.mtime, 0, 'pasta vazia não tem o que datar: mtime 0')
    assert.deepEqual(oca.children, [])
    assert.equal(tree.at(-1).name, 'oca', 'a pasta vazia afunda para o fim')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('os três vocabulários de caminho: path do container, ref do humano, rel como chave de rota', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-paths-'))
  const local = { name: 't', root: t, ref: '.scratch' }
  try {
    await mkdir(join(t, 'esf/issues'), { recursive: true })
    await writeFile(join(t, 'esf/issues/01-a.md'), '# A\n')

    const { tree } = await buildTree(local)
    const node = find(tree, '01-a.md')

    // `path` é o caminho no container — é por ele que o board lê.
    assert.equal(node.path, join(t, 'esf/issues/01-a.md'))
    // `ref` é o que o humano copia — na origem de casa, nu.
    assert.equal(node.ref, '.scratch/esf/issues/01-a.md')
    // `rel` é a chave de rota `#/<ns>/<rel>` — relativo à raiz, em POSIX, sem o container.
    assert.equal(node.rel, 'esf/issues/01-a.md')
    assert.equal(node.rel.includes(t), false, 'o rel nunca carrega o caminho do container')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('o ref das origens que não são a de casa é qualificado', async () => {
  const t = await mkdtemp(join(tmpdir(), 'tree-vend-'))
  const vend = { name: 'vend-server', root: t, ref: 'vend-server/.scratch' }
  try {
    await writeFile(join(t, 'map.md'), '# Mapa\n')
    const { tree, ref } = await buildTree(vend)
    assert.equal(tree[0].ref, 'vend-server/.scratch/map.md')
    // O `ref` de **topo** é o da origem, não o de um nó — é o que o cliente usa para o
    // nó-raiz sintético (`#/<ns>` sozinho), para o `path` do container nunca vazar pra UI.
    assert.equal(ref, 'vend-server/.scratch')
  } finally {
    await rm(t, { recursive: true, force: true })
  }
})

test('root inexistente é árvore vazia, não erro — o `.scratch/` que a branch não tem', async () => {
  const ausente = { name: 't', root: join(tmpdir(), `nunca-existiu-${Math.random()}`), ref: '.scratch' }
  const out = await buildTree(ausente)
  assert.deepEqual(out.tree, [])
  assert.equal('error' in out, false, 'sumir não é erro do disco')
})

test('errorTree devolve a origem quebrada, com a mensagem e a árvore vazia', () => {
  const out = errorTree(ns, 'EISDIR: illegal operation on a directory')
  assert.equal(out.ns, 't')
  assert.equal(out.root, root)
  // O `ref` viaja mesmo na árvore de erro — a aba de uma origem quebrada ainda precisa do
  // `ref` para o nó-raiz sintético, e a forma tem que casar com a de uma árvore de verdade.
  assert.equal(out.ref, '.scratch')
  assert.equal(out.error, 'EISDIR: illegal operation on a directory')
  assert.deepEqual(out.tree, [])
})

test('buildTree devolve `ns` (nome), `root` e `ref` (o da origem, não de um nó), sem carimbo de filesystem no topo', async () => {
  const { ns: name, root: r, ref } = await buildTree(ns)
  assert.equal(name, 't', 'o `ns` do topo é o nome, o mesmo do envelope SSE')
  assert.equal(r, root)
  assert.equal(ref, '.scratch', 'a origem de casa tem `ref` nu')
})
