/**
 * Os invariantes do grafo de uma pasta — que até agora só existiam em prosa (e só falavam a
 * língua das issues).
 *
 * Generalização (tarefa 06): o layout deixou de saber o que é uma issue. Ele recebe `nodes` +
 * `edges` — o mesmo par que o `/api/graph` serve, seja `mode:'deps'` (o `Blocked by:`, `from` =
 * bloqueante) ou `mode:'links'` (`from` = quem cita) —, e os invariantes são **os mesmos**: a
 * camada é o maior caminho, o ciclo não estoura, a ordem dentro da camada é o baricentro. Eles
 * falham em silêncio se quebrarem: o desenho continua saindo, só sai errado — uma seta andando
 * para trás, curvas cruzadas à toa, ou a aba travada num laço.
 *
 * Estes testes só existem porque o layout é puro, roda no Node sem harness, e é sobre objetos —
 * não sobre pixels.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { layerize, graphLayout, edgePath, NODE_W, NODE_H, GAP_X, GAP_Y, PAD } from '../public/graph-layout.js'

/** Um `GNode` como o `/api/graph` o serve — só o que o layout olha: o `id`. */
const N = (ids) => ids.map((id) => ({ id, number: id, name: id }))
/** O mesmo nó, para chamar `at()` sem guardar referência ao array de `N()` — o layout resolve
 * por `id`, não por identidade de objeto (é o `byId` que o generaliza). */
const node = (id) => ({ id, number: id, name: id })

describe('camada é o maior caminho; nenhuma aresta anda para trás', () => {
  test('C depende de A DIRETO e de B (que depende de A): o maior caminho vence o menor', () => {
    // C tem dois caminhos até A: direto (A→C, comprimento 1) e via B (A→B→C, comprimento 2).
    // Um layout por MENOR caminho poria C na camada 1 — ao lado de B, que ele espera — e a
    // seta B→C andaria para trás. É esse o bug histórico deste projeto (ver AGENTS.md: "esta
    // linha foi falsa durante todo o tempo em que esteve escrita aqui"), e o diamante
    // A→B,A→C,B→D,C→D não o pega: os dois caminhos até D têm o mesmo comprimento (2), então
    // um Math.min passaria por aqui idêntico a um Math.max. Este grafo diverge de propósito.
    const { at } = graphLayout(N(['A', 'B', 'C']), [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'C' },
    ])
    assert.ok(at(node('A')).x < at(node('B')).x)
    // Se C tivesse ficado na camada 1 (o caminho curto, direto de A), esta linha falharia:
    // é ela que prova o maior caminho, não só documenta a intenção.
    assert.ok(at(node('B')).x < at(node('C')).x, 'C fica DEPOIS de B (camada 2, via o caminho longo), não ao lado dele (camada 1, via A direto)')
  })

  test('quem não tem aresta chegando é a camada 0 — a frontier', () => {
    const layer = layerize(N(['A', 'B', 'C']), new Map([['C', [node('A')]]]))
    assert.equal(layer.get('A'), 0)
    assert.equal(layer.get('B'), 0)
    assert.equal(layer.get('C'), 1)
  })
})

describe('ciclo não estoura', () => {
  test('laço de dois não lança', () => {
    assert.doesNotThrow(() => {
      graphLayout(N(['A', 'B']), [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ])
    })
  })

  test('a aresta que fecha o laço é descartada — alguém sobra na camada 0', () => {
    // Se a aresta de volta valesse profundidade 0 em vez de nada, ninguém sobraria na
    // camada 0 e o `columns` nasceria com um buraco.
    const { columns, at } = graphLayout(N(['A', 'B']), [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ])
    assert.equal(columns[0].length, 1, 'alguém tem que sobrar na camada 0')
    assert.ok(Number.isFinite(at(node('A')).x) && Number.isFinite(at(node('B')).x))
  })
})

describe('modo links usa o mesmo layout', () => {
  test('map cita 01 e 02: map sozinho na frontier', () => {
    // As arestas de link (from = quem cita, to = citado) produzem a mesma geometria das
    // arestas de deps; é a mesma função, só muda de onde `edges` vem.
    const { columns } = graphLayout(N(['map', '01', '02']), [
      { from: 'map', to: '01' },
      { from: 'map', to: '02' },
    ])
    assert.equal(columns[0].length, 1) // map sozinho na frontier
    assert.deepEqual(
      columns[0].map((n) => n.id),
      ['map'],
    )
  })
})

describe('dentro da camada, a ordem é o baricentro', () => {
  test('quem tem baricentro menor fica acima; camada 0 ordena por id', () => {
    const { at, columns } = graphLayout(N(['01', '02', '03', '04', '05']), [
      { from: '03', to: '04' }, // 04 depende de 03 (linha 2) — baricentro 2
      { from: '01', to: '05' }, // 05 depende de 01 (linha 0) — baricentro 0
    ])
    assert.deepEqual(
      columns[0].map((n) => n.id),
      ['01', '02', '03'],
      'camada 0 sem âncora: ordena por id',
    )
    assert.deepEqual(columns[1].map((n) => n.id), ['05', '04'])
    assert.ok(at(node('05')).y < at(node('04')).y)
  })
})

describe('referência morta e auto-referência não viram aresta', () => {
  test('edge para um id fora de `nodes` não conta — sem aresta, uma coluna só', () => {
    const { columns } = graphLayout(N(['01', '02']), [{ from: '99', to: '02' }])
    assert.equal(columns.length, 1, 'sem aresta, o grafo é uma coluna só')
  })

  test('edge de um nó para si mesmo não conta', () => {
    const layer = layerize(N(['01']), new Map()) // deps vazio: sem aresta nenhuma sobrevive
    assert.equal(layer.get('01'), 0)
    const { columns } = graphLayout(N(['01']), [{ from: '01', to: '01' }])
    assert.equal(columns[0].length, 1)
  })
})

describe('a geometria que as curvas assumem', () => {
  test('o passo entre camadas e entre linhas é o do nó mais o vão', () => {
    const { at, width, height } = graphLayout(N(['01', '02', '03']), [{ from: '01', to: '03' }])
    assert.deepEqual(at(node('01')), { x: PAD, y: PAD })
    assert.equal(at(node('02')).y - at(node('01')).y, NODE_H + GAP_Y)
    assert.equal(at(node('03')).x - at(node('01')).x, NODE_W + GAP_X)
    assert.equal(width, 2 * (NODE_W + GAP_X) - GAP_X + PAD * 2)
    assert.equal(height, 2 * (NODE_H + GAP_Y) - GAP_Y + PAD * 2)
  })

  test('edgePath sai da borda direita do bloqueante e entra na esquerda do bloqueado', () => {
    const { at } = graphLayout(N(['01', '02']), [{ from: '01', to: '02' }])
    const d = edgePath(at(node('01')), at(node('02')))
    assert.match(d, /^M /)
    assert.ok(d.includes(`${at(node('01')).x + NODE_W} `))
  })
})

describe('guarda de pureza: sem document/window/innerHTML e sem issues.js', () => {
  test('graph-layout.js não toca no DOM nem importa o vocabulário morto das issues', () => {
    // Se o módulo passar a olhar `document`, os invariantes acima voltam a ser
    // indemonstráveis fora do navegador — e é assim que eles morrem.
    const src = readFileSync(new URL('../public/graph-layout.js', import.meta.url), 'utf8')
    for (const proibido of ['document', 'window', 'localStorage', 'innerHTML', 'issues.js']) {
      assert.ok(!src.includes(proibido), proibido)
    }
  })
})
