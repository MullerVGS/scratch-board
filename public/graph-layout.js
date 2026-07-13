/**
 * O layout do grafo de dependências — **puro**, sem uma linha de DOM.
 *
 * Recebe issues (objetos) e devolve geometria (números). É o módulo que os testes de
 * `test/graph-layout.test.js` travam, porque os invariantes do grafo — camada pelo
 * maior caminho, ciclo que não estoura, ordem por baricentro, referência morta que
 * não vira aresta — viviam só em prosa no `AGENTS.md`, e prosa ninguém lembra ao
 * mexer no layout. Nada aqui pode passar a olhar `document`: o dia em que olhar, o
 * invariante volta a ser indemonstrável.
 */
import { depsOf } from './issues.js'

/**
 * A altura do nó é **fixa** porque entra no cálculo da posição das curvas: título que
 * estica desalinha as setas — daí o clamp de duas linhas no CSS.
 */
export const NODE_W = 236
export const NODE_H = 80
export const GAP_X = 92
export const GAP_Y = 18
export const PAD = 18

/**
 * Um Gantt gasta o eixo X com tempo; este grafo gasta com **profundidade**.
 *
 * O `.scratch/` não tem data de início nem duração, e inventá-las à mão em cada `.md`
 * seria criar um estado que ninguém mantém — datas podres mentem com mais confiança
 * que a ausência delas. Mas as setas de um Gantt não precisam de tempo: elas são as
 * arestas do `Blocked by:`, e essas existem. Trocado o eixo, a camada 0 passa a ser a
 * frontier — o que dá para atacar agora — e cada coluna à direita é o que aquilo
 * destrava.
 *
 * A camada é o **maior** caminho até uma issue sem dependência, não o menor: com o
 * menor, um nó apareceria à esquerda de algo que ele espera, e a seta andaria para
 * trás. Ciclo não deveria existir num `Blocked by:`, mas se existir a aresta de volta
 * é ignorada em vez de estourar a pilha — o board mostra o que o arquivo diz, e um
 * arquivo pode estar errado.
 */
export function layerize(issues, byNumber) {
  const layer = new Map()
  const visiting = new Set()

  const depth = (issue) => {
    if (layer.has(issue)) return layer.get(issue)
    visiting.add(issue)
    // A aresta que fecha o laço é **descartada** — não vale 0, vale nada. Contá-la como
    // profundidade 0 empurraria `depth(dep) + 1` para dentro da conta e ninguém sobraria
    // na camada 0: o `columns` do layout nasceria com um buraco, e o grafo inteiro
    // estouraria num `TypeError` ao ordenar a coluna que não existe. Num grafo sem ciclo
    // — que é todo grafo legítimo — `visiting` nunca contém um dep, e a conta é a mesma.
    const d = depsOf(issue, byNumber).reduce(
      (max, { dep }) => (visiting.has(dep) ? max : Math.max(max, depth(dep) + 1)),
      0,
    )
    visiting.delete(issue)
    layer.set(issue, d)
    return d
  }

  issues.forEach(depth)
  return layer
}

/**
 * Dentro da camada, a ordem é o baricentro das dependências: um nó fica na altura da
 * média dos que o bloqueiam. É o que evita que as curvas se cruzem sem necessidade —
 * e como as camadas são resolvidas da esquerda para a direita, quem serve de âncora já
 * tem linha quando é consultado. A camada 0 não tem âncora nenhuma: ordena por número.
 */
export function graphLayout(issues, byNumber) {
  const layer = layerize(issues, byNumber)
  const columns = []
  for (const issue of issues) (columns[layer.get(issue)] ??= []).push(issue)

  const row = new Map()
  for (const [li, column] of columns.entries()) {
    const bary = (issue) => {
      const rows = depsOf(issue, byNumber).map(({ dep }) => row.get(dep)).filter((r) => r !== undefined)
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0
    }
    column.sort((a, b) => (li ? bary(a) - bary(b) : 0) || a.number.localeCompare(b.number))
    column.forEach((issue, ri) => row.set(issue, ri))
  }

  const at = (issue) => ({
    x: PAD + layer.get(issue) * (NODE_W + GAP_X),
    y: PAD + row.get(issue) * (NODE_H + GAP_Y),
  })
  const height = Math.max(...columns.map((c) => c.length)) * (NODE_H + GAP_Y) - GAP_Y + PAD * 2

  return { at, columns, width: columns.length * (NODE_W + GAP_X) - GAP_X + PAD * 2, height }
}

/** Sai da borda direita do bloqueante e entra na esquerda do bloqueado, sempre. */
export function edgePath(from, to) {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x
  const y2 = to.y + NODE_H / 2
  const bend = Math.max(GAP_X * 0.55, (x2 - x1) * 0.4)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}
