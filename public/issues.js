/**
 * As issues de um esforço, como objetos — **sem DOM**.
 *
 * É o vocabulário que o kanban, o grafo e a gaveta compartilham: qual é o título
 * limpo, quem depende de quem, o que ainda segura quem.
 */

/**
 * O título do arquivo costuma repetir o número (`06 — Task: ...`), que o card já
 * mostra à esquerda. Some com o prefixo — inclusive no texto copiado, porque o que
 * se cola num prompt é o nome da issue, não a numeração dela.
 */
export const cleanTitle = (issue) =>
  issue.number ? issue.title.replace(new RegExp(`^0*${Number(issue.number)}\\s*[—–-]\\s*`), '') : issue.title

/** Índice por número canônico (dois dígitos) — é ele que resolve a referência do `Blocked by:`. */
export const numberIndex = (issues) => new Map(issues.map((i) => [i.number.padStart(2, '0'), i]))

/**
 * As referências do `Blocked by:` são locais ao esforço (`01`, `02`) — o grafo de um
 * esforço nunca alcança outro. Uma referência a issue inexistente é descartada aqui:
 * não há nó para ligar, e o servidor já não a conta como bloqueio. Auto-referência
 * também cai: um nó não é aresta para si mesmo.
 */
export function depsOf(issue, byNumber) {
  return issue.blockedBy
    .map((d) => ({ ...d, dep: byNumber.get(d.number) }))
    .filter((d) => d.dep && d.dep !== issue)
}

/** As dependências que ainda seguram a issue — as fechadas já cumpriram o papel delas. */
export const openDeps = (issue, effort) =>
  depsOf(issue, numberIndex(effort.issues)).filter((d) => !d.dep.closed)
