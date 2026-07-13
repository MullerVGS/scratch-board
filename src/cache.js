// O board em memória, e a única pergunta que autoriza um push: **mudou de verdade?**
//
// `buildBoard()` é "leia o disco agora" — sem estado, sem memória, sem cache. Isso é de
// propósito, e a divisão é esta: o `board.js` sabe *como* montar a projeção, o cache
// decide *quando* montá-la e se alguém precisa saber. Cache dentro do `board.js` fecharia
// as duas coisas num nó só e a supressão deixaria de ser demonstrável.
//
// **A supressão é o coração do push.** Um evento de disco não é uma mudança no board: um
// `.swp` que aparece e some, um agente reescrevendo um arquivo com o conteúdo igual, um
// `touch`, um diretório temporário. Todos mexem no `.scratch/` e nenhum muda um pixel do
// que a tela mostra. Hoje todos viram re-render. Aqui, o board novo é serializado e
// comparado com o que já foi empurrado: **byte-idêntico ⇒ ninguém é avisado.** Nenhum byte
// no fio, nenhum re-render, nenhuma piscada.
//
// É por isso que `effort.mtime` teve que sair do payload: era o `mtime` de um *diretório*,
// que pula quando qualquer entrada nasce, morre ou é renomeada dentro dele — inclusive por
// arquivo que o board nem projeta. No hash, ele moveria o hash sem o board mudar, e a
// supressão viraria decoração.

import { createHash } from 'node:crypto'

import { buildBoard } from './board.js'

const hashOf = (json) => createHash('sha1').update(json).digest('hex')

let json = null
let hash = null

/**
 * Relê o disco, remonta o board e diz se ele mudou.
 *
 * `changed` é o único sinal que autoriza um push — e é falso sempre que a leitura nova é
 * byte-a-byte a leitura velha. A primeira leitura sempre muda: não havia board antes.
 */
export async function refresh() {
  const next = JSON.stringify(await buildBoard())
  const nextHash = hashOf(next)
  const changed = nextHash !== hash
  json = next
  hash = nextHash
  return { json, hash, changed }
}

/** O board como a última leitura o viu — lendo o disco se ninguém leu ainda. */
export async function current() {
  if (json === null) return await refresh()
  return { json, hash, changed: false }
}
