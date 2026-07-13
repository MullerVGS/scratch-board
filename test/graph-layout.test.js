/**
 * Os invariantes do grafo de dependências — que até agora só existiam em prosa.
 *
 * O `AGENTS.md` os escreveu ("a camada é o maior caminho", "ciclo não estoura", "dentro
 * da camada, a ordem é o baricentro"), mas prosa ninguém lembra ao mexer no layout — e
 * as três falham em **silêncio**: o desenho continua saindo, só sai errado. Uma seta
 * andando para trás, curvas cruzadas à toa, ou a aba travada num laço.
 *
 * Estes testes só existem porque o layout foi separado do render: `graph-layout.js` é
 * puro, roda no Node sem harness, e é sobre objetos — não sobre pixels.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { numberIndex, depsOf, openDeps } from '../public/issues.js'
import { layerize, graphLayout, NODE_W, NODE_H, GAP_X, GAP_Y, PAD } from '../public/graph-layout.js'

/**
 * Uma issue como o `/api/board` a serializa — só os campos que o layout olha.
 * `blocked` e `closed` vêm do servidor; o layout não os recalcula.
 */
const issue = (number, blockedBy = [], extra = {}) => ({
  number,
  title: `${number} — issue ${number}`,
  status: 'ready-for-agent',
  closed: false,
  blocked: blockedBy.length > 0,
  blockedBy: blockedBy.map((n) => ({ number: n, note: '', raw: n })),
  ...extra,
})

/** O grafo sempre parte das issues do esforço e do índice por número. */
const layout = (issues) => graphLayout(issues, numberIndex(issues))
const layers = (issues) => layerize(issues, numberIndex(issues))

describe('a camada é o MAIOR caminho, não o menor', () => {
  test('um nó com dois caminhos até a raiz vai para o mais longo', () => {
    // 03 depende de 01 (caminho curto) e de 02 (caminho longo, que passa por 01).
    // Pelo menor caminho, 03 cairia na camada 1 — ao lado do 02, que ele espera —,
    // e a seta 02 → 03 andaria para trás.
    const a = issue('01')
    const b = issue('02', ['01'])
    const c = issue('03', ['01', '02'])
    const layer = layers([a, b, c])

    assert.equal(layer.get(a), 0)
    assert.equal(layer.get(b), 1)
    assert.equal(layer.get(c), 2, 'a camada de 03 é o caminho longo (via 02), não o curto (via 01)')
  })

  test('nenhuma aresta anda para trás: o bloqueante está sempre à esquerda', () => {
    const issues = [
      issue('01'),
      issue('02', ['01']),
      issue('03', ['01', '02']),
      issue('04', ['02']),
      issue('05', ['03', '04']),
    ]
    const byNumber = numberIndex(issues)
    const { at } = graphLayout(issues, byNumber)

    for (const i of issues) {
      for (const { dep } of depsOf(i, byNumber)) {
        assert.ok(
          at(dep).x < at(i).x,
          `a aresta ${dep.number} → ${i.number} anda para trás: o bloqueante teria que ficar à esquerda`,
        )
      }
    }
  })

  test('quem não depende de ninguém é a camada 0 — a frontier', () => {
    const issues = [issue('01'), issue('02'), issue('03', ['01'])]
    const layer = layers(issues)
    assert.equal(layer.get(issues[0]), 0)
    assert.equal(layer.get(issues[1]), 0)
  })
})

describe('ciclo não estoura a pilha', () => {
  test('laço de dois: a aresta que fecha o laço é ignorada', () => {
    // Não deveria existir num `Blocked by:`. Mas o board mostra o que o arquivo diz,
    // e um arquivo pode estar errado — errado não é motivo para derrubar a aba.
    const a = issue('01', ['02'])
    const b = issue('02', ['01'])
    const layer = layers([a, b])

    assert.equal(layer.size, 2)
    for (const i of [a, b]) assert.ok(Number.isFinite(layer.get(i)), 'toda issue recebe uma camada finita')

    // E o layout inteiro sai: descartada a aresta que fecha o laço, sobra alguém na
    // camada 0. Se ela valesse 0 em vez de nada, ninguém sobraria lá — e o `columns`
    // nasceria com um buraco que derruba o grafo num `TypeError`.
    const { at, columns } = layout([a, b])
    assert.equal(columns[0].length, 1, 'alguém tem que sobrar na camada 0')
    assert.ok(Number.isFinite(at(a).x) && Number.isFinite(at(b).x))
  })

  test('laço de três, e um nó pendurado nele', () => {
    const issues = [issue('01', ['03']), issue('02', ['01']), issue('03', ['02']), issue('04', ['03'])]
    const { at, width, height } = layout(issues)

    for (const i of issues) {
      const p = at(i)
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `a issue ${i.number} tem posição finita`)
    }
    assert.ok(Number.isFinite(width) && Number.isFinite(height))
  })

  test('auto-referência não vira aresta nem camada', () => {
    const a = issue('01', ['01'])
    const byNumber = numberIndex([a])
    assert.deepEqual(depsOf(a, byNumber), [], 'um nó não é aresta para si mesmo')
    assert.equal(layerize([a], byNumber).get(a), 0)
  })
})

describe('dentro da camada, a ordem é o baricentro das dependências', () => {
  test('o nó fica na altura média de quem o bloqueia, não na ordem do número', () => {
    // Camada 0, por número: 01 (linha 0), 02 (linha 1), 03 (linha 2).
    // Camada 1: 04 depende do 03 (baricentro 2) e 05 depende do 01 (baricentro 0).
    // Por número, 04 viria antes de 05; pelo baricentro, 05 sobe e as curvas param de
    // se cruzar.
    const issues = [issue('01'), issue('02'), issue('03'), issue('04', ['03']), issue('05', ['01'])]
    const { at, columns } = layout(issues)
    const [i01, , , i04, i05] = issues

    assert.deepEqual(
      columns[1].map((i) => i.number),
      ['05', '04'],
      'na camada 1, o baricentro põe 05 (média 0) antes de 04 (média 2)',
    )
    // O baricentro decide a **ordem** dentro da camada; a linha é reindexada de 0 a n-1
    // depois. Por isso 05, o primeiro da camada 1, acaba na altura do 01 — mas 04, o
    // segundo, sobe para a linha 1 em vez de descer até a linha do 03.
    assert.ok(at(i05).y < at(i04).y, 'quem tem baricentro menor fica acima')
    assert.equal(at(i05).y, at(i01).y)
  })

  test('duas dependências: a altura é a média das duas', () => {
    // 04 é bloqueado por 01 (linha 0) e 03 (linha 2) — baricentro 1. 05 é bloqueado só
    // pelo 03 — baricentro 2. Logo 04 vem antes de 05, ainda que ambos sejam camada 1.
    const issues = [issue('01'), issue('02'), issue('03'), issue('04', ['01', '03']), issue('05', ['03'])]
    const { columns } = layout(issues)
    assert.deepEqual(columns[1].map((i) => i.number), ['04', '05'])
  })

  test('a camada 0 não tem âncora: ordena por número', () => {
    const issues = [issue('03'), issue('01'), issue('02')]
    const { columns } = layout(issues)
    assert.deepEqual(columns[0].map((i) => i.number), ['01', '02', '03'])
  })
})

describe('referência a issue inexistente', () => {
  test('não vira aresta', () => {
    // `Blocked by: 99` num esforço que só tem duas issues: não há nó para ligar.
    const a = issue('01')
    const b = issue('02', ['99'])
    const byNumber = numberIndex([a, b])

    assert.deepEqual(depsOf(b, byNumber), [])
    const { columns } = graphLayout([a, b], byNumber)
    assert.equal(columns.length, 1, 'sem aresta, o grafo é uma coluna só')
  })

  test('não vira bloqueio: o card não lista dependente nenhum', () => {
    const b = issue('02', ['99'])
    const effort = { issues: [issue('01'), b] }
    assert.deepEqual(openDeps(b, effort), [], 'nada segura a 02 — o 99 não existe')
  })

  test('a referência morta some, a viva fica', () => {
    const a = issue('01')
    const b = issue('02', ['01', '99'])
    const deps = depsOf(b, numberIndex([a, b]))
    assert.deepEqual(deps.map((d) => d.dep.number), ['01'])
  })
})

describe('a geometria que as curvas assumem', () => {
  test('o passo entre camadas e entre linhas é o do nó mais o vão', () => {
    // A altura do nó é fixa (NODE_H) porque entra no cálculo da posição das curvas:
    // título que estica desalinha as setas.
    const issues = [issue('01'), issue('02'), issue('03', ['01'])]
    const { at, width, height } = layout(issues)
    const [i01, i02, i03] = issues

    assert.deepEqual(at(i01), { x: PAD, y: PAD })
    assert.equal(at(i02).y - at(i01).y, NODE_H + GAP_Y)
    assert.equal(at(i03).x - at(i01).x, NODE_W + GAP_X)
    assert.equal(width, 2 * (NODE_W + GAP_X) - GAP_X + PAD * 2)
    assert.equal(height, 2 * (NODE_H + GAP_Y) - GAP_Y + PAD * 2)
  })

  test('o esforço deste board inteiro cabe no layout sem exceção', () => {
    // As dez issues deste mapa, com as arestas que os arquivos declaram — inclusive a
    // 10, que espera quatro.
    const issues = [
      issue('01'),
      issue('02', ['01']),
      issue('03', ['01', '02']),
      issue('04', ['02']),
      issue('05', ['03', '04']),
      issue('06', ['05']),
      issue('07', ['05']),
      issue('08'),
      issue('09'),
      issue('10', ['05', '06', '07', '08']),
    ]
    const byNumber = numberIndex(issues)
    const { at, columns } = graphLayout(issues, byNumber)

    // 01 → 02 → 03 → 05 → 06/07 → 10: a cadeia mais longa tem seis nós, logo seis
    // camadas. O 10 cai na última porque espera o 06 e o 07, não só o 05.
    assert.equal(columns.length, 6)
    assert.equal(columns[5].map((i) => i.number).join(), '10')
    for (const i of issues) {
      for (const { dep } of depsOf(i, byNumber)) assert.ok(at(dep).x < at(i).x)
    }
  })
})

describe('o layout é puro', () => {
  test('nem `graph-layout.js` nem `issues.js` tocam no DOM', () => {
    // Se um deles passar a olhar `document`, os invariantes acima voltam a ser
    // indemonstráveis fora do navegador — e é assim que eles morrem. A varredura é no
    // *código*, com os comentários fora: a prosa que explica a regra pode nomeá-la.
    for (const mod of ['../public/graph-layout.js', '../public/issues.js']) {
      const code = readFileSync(new URL(mod, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const forbidden of ['document', 'window', 'navigator', 'localStorage', 'innerHTML']) {
        assert.ok(!code.includes(forbidden), `${mod} não pode tocar em \`${forbidden}\``)
      }
      // E o que ele importa também não pode arrastar DOM junto.
      const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      assert.deepEqual(
        imports.filter((i) => !['./issues.js'].includes(i)),
        [],
        `${mod} só pode importar de módulos puros`,
      )
    }
  })
})
