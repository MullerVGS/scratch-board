/**
 * O layout do grafo de uma pasta — **puro**, sem uma linha de DOM.
 *
 * Recebe `nodes` + `edges` — o mesmo par que o `/api/graph` serve, seja `mode:'deps'` (o
 * `Blocked by:`, `from` = bloqueante, `to` = bloqueado) ou `mode:'links'` (`from` = quem cita,
 * `to` = citado) — e devolve geometria (números). É o módulo que os testes de
 * `test/graph-layout.test.js` travam, porque os invariantes do grafo — camada pelo maior
 * caminho, ciclo que não estoura, ordem por baricentro, referência morta que não vira aresta —
 * viviam só em prosa no `AGENTS.md`, e prosa ninguém lembra ao mexer no layout. Nada aqui pode
 * voltar a depender do navegador: o dia em que depender, o invariante volta a ser indemonstrável.
 *
 * Já era puro quando só falava a língua das issues (`issues` + `byNumber`, com o vocabulário de
 * dependências do módulo antigo, hoje morto); a generalização (tarefa 06) trocou só de onde as
 * arestas vêm — os invariantes são os mesmos, e valem tanto para `deps` quanto para `links`.
 */

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
 * `deps`: `Map(id → [nó a montante...])`, montado a partir de `edges` (`to` → lista dos `from`
 * resolvidos contra `byId`). Uma referência morta (`from`/`to` fora de `nodes`) não vira
 * aresta — não há nó para ligar; e uma auto-referência (`from === to`) também não — um nó não é
 * aresta para si mesmo. Vale para `deps` e para `links`.
 */
function depsFromEdges(byId, edges) {
  const deps = new Map()
  for (const { from, to } of edges) {
    const f = byId.get(from)
    const t = byId.get(to)
    if (!f || !t || f === t) continue
    const list = deps.get(t.id)
    list ? list.push(f) : deps.set(t.id, [f])
  }
  return deps
}

/**
 * O eixo X do grafo é **profundidade**, não tempo.
 *
 * O `.scratch/` não tem data de início nem duração, e inventá-las à mão em cada `.md`
 * seria criar um estado que ninguém mantém — datas podres mentem com mais confiança
 * que a ausência delas. Mas as setas não precisam de tempo: elas são as arestas do
 * `Blocked by:` (ou do link relativo), e essas existem. Com o eixo em profundidade, a
 * camada 0 passa a ser a frontier — o que dá para atacar agora — e cada coluna à
 * direita é o que aquilo destrava.
 *
 * A camada é o **maior** caminho até um nó sem dependência, não o menor: com o
 * menor, um nó apareceria à esquerda de algo que ele espera, e a seta andaria para
 * trás. Ciclo não deveria existir num `Blocked by:` nem numa cadeia de links, mas se
 * existir a aresta de volta é ignorada em vez de estourar a pilha — o board mostra o
 * que o arquivo diz, e um arquivo pode estar errado.
 */
export function layerize(nodes, deps) {
  const layer = new Map()
  const visiting = new Set()

  const depth = (n) => {
    if (layer.has(n.id)) return layer.get(n.id)
    visiting.add(n.id)
    // A aresta que fecha o laço é **descartada** — não vale 0, vale nada. Contá-la como
    // profundidade 0 empurraria `depth(dep) + 1` para dentro da conta e ninguém sobraria
    // na camada 0: o `columns` do layout nasceria com um buraco, e o grafo inteiro
    // estouraria num `TypeError` ao ordenar a coluna que não existe. Num grafo sem ciclo
    // — que é todo grafo legítimo — `visiting` nunca contém um dep, e a conta é a mesma.
    const d = (deps.get(n.id) ?? []).reduce(
      (max, dep) => (visiting.has(dep.id) ? max : Math.max(max, depth(dep) + 1)),
      0,
    )
    visiting.delete(n.id)
    layer.set(n.id, d)
    return d
  }

  nodes.forEach(depth)
  return layer
}

/**
 * Dentro da camada, a ordem é o baricentro das dependências: um nó fica na altura da
 * média dos que o apontam. É o que evita que as curvas se cruzem sem necessidade —
 * e como as camadas são resolvidas da esquerda para a direita, quem serve de âncora já
 * tem linha quando é consultado. A camada 0 não tem âncora nenhuma: ordena por `id`.
 *
 * `at()` resolve por **`id`**, não por identidade de objeto — assim um nó recriado (o mesmo
 * `id`, outra instância) ainda encontra a posição certa, o que é o que faz `graphLayout` ser
 * chamável com `nodes`/`edges` frescos a cada fetch sem ninguém guardar referência velha.
 */
export function graphLayout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const deps = depsFromEdges(byId, edges)

  const layer = layerize(nodes, deps)
  const columns = []
  for (const n of nodes) (columns[layer.get(n.id)] ??= []).push(n)

  const row = new Map()
  for (const [li, column] of columns.entries()) {
    const bary = (n) => {
      const rows = (deps.get(n.id) ?? []).map((d) => row.get(d.id)).filter((r) => r !== undefined)
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0
    }
    column.sort((a, b) => (li ? bary(a) - bary(b) : 0) || String(a.id).localeCompare(String(b.id)))
    column.forEach((n, ri) => row.set(n.id, ri))
  }

  const at = (n) => ({
    x: PAD + layer.get(n.id) * (NODE_W + GAP_X),
    y: PAD + row.get(n.id) * (NODE_H + GAP_Y),
  })
  const height = Math.max(...columns.map((c) => c.length)) * (NODE_H + GAP_Y) - GAP_Y + PAD * 2

  return { at, columns, width: columns.length * (NODE_W + GAP_X) - GAP_X + PAD * 2, height }
}

/** Sai da borda direita do nó de origem e entra na esquerda do de destino, sempre. */
export function edgePath(from, to) {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x
  const y2 = to.y + NODE_H / 2
  const bend = Math.max(GAP_X * 0.55, (x2 - x1) * 0.4)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}
