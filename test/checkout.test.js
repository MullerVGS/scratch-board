/**
 * O root que troca de inode — o caso do `git checkout`.
 *
 * As origens são **repos**, e o `.scratch/` de um repo é um diretório **versionado**. Fazer
 * checkout de uma branch que não o contém faz o git **apagá-lo inteiro**; voltar para a de
 * antes o **recria, com um inode novo**. Não é hipótese: no `vend-server`, `main` não tem
 * `.scratch/`; no `pos`, nenhuma das branches antigas tem.
 *
 * O que este arquivo trava é o **contrato do layout**: a origem é o `.scratch/` *dentro* do
 * repo montado, e um `.scratch/` que não existe agora é uma árvore **vazia**, não um erro. São
 * as duas propriedades que fazem a leitura sobreviver ao checkout — porque o root passa a ser
 * resolvido por *caminho* a cada `readdir`, e o caminho acha o diretório que nasceu.
 *
 * **O que ele deliberadamente NÃO testa, e por quê.** O bug de verdade era o bind mount:
 * montando o `.scratch/` em si, o container ficava preso ao inode que o git apagou e via um
 * diretório vazio **para sempre**. Isso é propriedade do **mount**, e não tem como afirmá-la
 * aqui: sem um bind mount por baixo, um `readdir` por caminho sempre acha o inode novo, e este
 * arquivo passaria **idêntico com o compose errado**. Um verde aqui seria falsa confiança. Quem
 * prova aquilo é um bind mount de verdade com um `git checkout` de verdade.
 *
 * Arquivo separado por uma razão de fixture: ele **apaga o root**, e uma suíte que
 * compartilha o disco não sobreviveria a isso no meio.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts
let repo // o mount: o **repo**, não o `.scratch/`
let root // a origem: o `.scratch/` dentro dele — o que o git apaga e recria
let server
let base

async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status) => `Status: ${status}\nType: task\n\n# ${title}\n\nCorpo.\n`

const boardOf = async () => (await (await fetch(`${base}/api/board?ns=projetos`)).json())

/** Acha um nó pelo nome, em qualquer profundidade. */
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
  mounts = await mkdtemp(join(tmpdir(), 'board-checkout-'))
  // O mount é o **repo**; a origem é o `.scratch/` dentro dele. É esta linha que carrega a
  // decisão: o diretório que o compose monta é o que o git **nunca** apaga.
  repo = join(mounts, 'projetos')
  root = join(repo, '.scratch')
  await mkdir(root, { recursive: true })
  process.env.REPOS_DIR = mounts

  await put('antes/map.md', '# O esforço de antes\n\nNasceu na branch de trabalho.\n')
  await put('antes/issues/01-um.md', issue('01 — Um', 'ready-for-agent'))

  const mod = await import('../src/server.js')
  server = await mod.start(0) // varredura no padrão: 90s, ou seja, nunca dentro do teste
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
})

test('a origem é o `.scratch/` dentro do repo montado', async () => {
  // O contrato do compose, dito pelo fio: o mount é o repo, e o board procura o `.scratch/`
  // lá dentro. O `ref` continua sendo o do humano — o caminho a partir de `/root/projetos`.
  const b = await boardOf()
  assert.equal(b.root, root, 'a origem tem que ser o .scratch/ de dentro do repo, não o repo')
  const antes = find(b.tree, 'antes')
  assert.ok(antes, 'o esforço da branch de trabalho não foi lido')
  assert.equal(antes.ref, '.scratch/antes', 'a origem de casa continua com o ref nu')
})

test('o `.scratch/` que o checkout apagou some do board, e isso não é erro', async () => {
  // `git checkout main`, onde `main` não tem `.scratch/`. O diretório deixa de existir.
  // **Vazio é a verdade agora**, não uma falha: a branch realmente não tem esforço nenhum.
  await rm(root, { recursive: true, force: true })

  const b = await boardOf()
  assert.deepEqual(b.tree, [], 'a branch não tem .scratch/: o board tem que dizer vazio')
  assert.equal(b.error, undefined, 'sumir com o checkout não é erro do board')
})

test('e o que o checkout de volta recria é lido — o root é resolvido por caminho', async () => {
  // `git checkout <branch-de-trabalho>` de volta: o `.scratch/` renasce, e o esforço com ele.
  // Nada aqui guarda um handle do diretório de antes: cada leitura resolve `ns.root` do zero.
  await put('depois/map.md', '# O esforço de depois\n\nO checkout trouxe de volta.\n')
  await put('depois/issues/01-um.md', issue('01 — Um', 'ready-for-agent'))

  const b = await boardOf()
  const depois = find(b.tree, 'depois')
  assert.ok(depois, 'o board não achou o que o checkout recriou')
  assert.ok(find(depois.children, '01-um.md'), 'a issue do esforço recriado não foi lida')
})
