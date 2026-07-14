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

/**
 * **O limiar do rótulo de parada, em dias**, e ele mora no cliente de propósito.
 *
 * Se o corte fosse do servidor — publicar o carimbo só acima dele —, um ticket cruzando os
 * três dias **à meia-noite** mudaria o payload sem ninguém ter escrito nada, e a varredura
 * seguinte empurraria o board inteiro sozinha. O servidor manda o fato (`issue.touched`, o
 * dia em que o ticket parou); quem envelhece é o relógio de quem olha.
 *
 * **Três dias, e não é gosto — é um vale medido na frota.** Dos 79 tickets abertos:
 *
 * | dias parados | 0 | 1 | 2 | 3 | 4 | 5 |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | tickets | 25 | 29 | 16 | **0** | 8 | 1 |
 *
 * Nada mora no dia 3: as duas populações — trabalho recente e trabalho encalhado — não se
 * tocam, e o corte cai no buraco entre elas. Em `2`, um terço do board sairia rotulado e o
 * rótulo deixaria de informar (dois dias cabem inteiros num fim de semana); em `3`, quem
 * acende é só o que de fato travou.
 */
export const STALE_DAYS = 3

/**
 * O rótulo do card, ou `null` quando ele não informa nada.
 *
 * Duas ausências deliberadas, e as duas são o board **calando** em vez de mentir:
 *
 * - **Issue fechada nunca está parada** — está pronta. O `mtime` de um ticket `resolved` é a
 *   **resolução** dele, e um "parado há 30 dias" ali seria uma data verdadeira contando uma
 *   história falsa.
 * - **Sem carimbo, nada é dito.** Não se inventa uma data para ter o que mostrar.
 *
 * O `now` entra por parâmetro porque a conta é pura — e é assim que ela se testa sem relógio
 * nenhum a mockar.
 */
export function staleLabel(issue, now = Date.now()) {
  if (issue.closed || !issue.touched) return null
  // Dias inteiros, dos dois lados: o carimbo já vem quantizado por dia (o servidor o derivou
  // assim), então a hora não entra na conta e o número não escorrega ao longo do dia.
  //
  // A conta é em dia **UTC**, dos dois lados — e a assimetria assumida é que, num fuso a
  // oeste, o contador vira algumas horas antes da meia-noite de quem olha. Num rótulo cuja
  // granularidade **é** o dia, e cujo limiar são três, isso não muda nada do que ele informa;
  // misturar dia local com carimbo UTC é que daria erro de um dia de verdade.
  const days = Math.floor(now / 864e5) - Math.floor(Date.parse(issue.touched) / 864e5)
  return days >= STALE_DAYS ? `parado há ${days} dias` : null
}
