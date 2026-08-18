// Os roots que o board lê, e a tradução entre os dois vocabulários de caminho.
//
// Um **namespace** é um `.scratch/` inteiro — esforços, mapas, issues, archive, grafo,
// gaveta, comandos, push. O board não tem mais *um* `.scratch/`: ele tem os que estiverem
// montados sob o diretório comum (`REPOS`), e **cada filho direto dele é um namespace**,
// com o nome da pasta como nome do namespace.
//
// **O que se monta é o repo, e a origem é o `.scratch/` dentro dele.** Essa indireção é a
// correção de um bug que matava o board em silêncio, e ela não é estética: um bind mount se
// prende ao **inode**, não ao caminho. O `.scratch/` de um repo é **versionado**, e o `git
// checkout` de uma branch que não o contém o **apaga inteiro** — no `vend-server`, `main`
// não tem `.scratch/`; no `pos`, nenhuma branch antiga tem. Montando o `.scratch/`
// diretamente, o container ficava preso ao inode que o git tinha acabado de apagar: quando
// o checkout de volta o recriava (inode novo), o board via um diretório vazio **para
// sempre**, e a aba mostrava um repo cheio de esforços como um repo sem nenhum. Nem a
// varredura de segurança curava — ela relia pelo mesmo mount morto; só recriar o container.
//
// O diretório do **repo**, esse, o git nunca apaga. Montado ele, o `.scratch/` é resolvido
// por *caminho* a cada leitura, e o inode novo é achado sozinho.
//
// **O compose é a configuração, e é a única.** Não há lista em env, nem arquivo de config
// paralelo: um mount novo sob o mesmo diretório é uma origem nova no próximo start. Uma
// segunda lista seria uma segunda fonte da verdade, e as duas divergiriam.
//
// Os mesmos arquivos têm dois nomes: o do container, que o board usa para ler, e o do
// workspace, que é o único que faz sentido colar num agente. Cada item da API carrega os
// dois — `path` para o board, `ref` para o humano. **Os comandos partem de
// `/root/projetos`**, e é isso que decide o `ref` de cada origem: a de casa produz
// `.scratch/...` (o caminho é relativo a ela mesma) e qualquer outra produz
// `<nome>/.scratch/...`. O caminho interno do container nunca é apresentado.
//
// Vive num módulo só porque `tree.js` e `server.js` precisam disto: se a tradução morasse no
// `server.js`, o `tree.js` o importaria de volta — ciclo.

import { readdir } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'

/**
 * O diretório comum. Cada filho direto é **um repo montado**, e o namespace que sai dele tem
 * o nome da pasta. O compose decide quais existem.
 *
 * Chama-se `repos` porque é o que ele contém. Já se chamou `scratches` e montava os
 * `.scratch/` em si — o nome ficou mentiroso no dia em que o conteúdo mudou, e nome
 * mentiroso aqui custa caro: é ele que faz alguém remontar o `.scratch/` direto e
 * ressuscitar o bug do inode preso (ver o cabeçalho).
 */
export const REPOS = resolve(process.env.REPOS_DIR ?? '/workspace/repos')

/**
 * A origem de casa: o workspace de onde os comandos partem. É a primeira aba, e a única
 * cujo `ref` é nu — `.scratch/...`, não `projetos/.scratch/...`, porque colar o segundo
 * num agente que já roda em `/root/projetos` não leva a lugar nenhum.
 */
const HOME = process.env.HOME_NS ?? 'projetos'

/** O caminho `path`, dito no vocabulário de `ref` — ou `null` se ele não mora sob `root`. */
const under = (root, ref, path) => {
  if (path !== root && !path.startsWith(root + sep)) return null
  const rest = relative(root, path)
  return rest ? `${ref}/${rest}` : ref
}

export const refIn = (ns, path) => under(ns.root, ns.ref, path) ?? path

/**
 * As origens montadas, na ordem em que aparecem: **a de casa primeiro**, o resto em ordem
 * alfabética. Um repo que ninguém montou não existe para o board, e um diretório comum
 * vazio devolve lista vazia — que a tela sabe dizer.
 *
 * **A origem existe porque o repo está montado, não porque o `.scratch/` está lá agora.** Um
 * repo cuja branch atual não tem `.scratch/` vira uma origem de board vazio — e vazio é a
 * verdade: a branch não tem esforço nenhum. Condicionar a descoberta à existência do
 * diretório reintroduziria o bug por outra porta, porque ela roda **uma vez, no `start()`**:
 * a aba sumiria e só voltaria no próximo `docker compose up -d --force-recreate`, o que é o
 * mesmo silêncio de antes com outra roupa.
 *
 * Roda uma vez, no `start()`: a descoberta é do startup, e um mount novo só aparece quando
 * o container é recriado. É o que o compose já garante — mudar o compose *é* recriar.
 */
export async function discover(dir = REPOS) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { /* nada montado ainda, ou nunca */ }

  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => (a === HOME ? -1 : b === HOME ? 1 : a.localeCompare(b)))
    .map((name) => ({
      name,
      // O que se monta é o repo; a origem é o `.scratch/` de dentro. O `root` continua sendo
      // o que o `safePath()` prende e o que o watcher vigia, então o board segue sem
      // enxergar um byte do repo fora do `.scratch/` — montar mais não é servir mais.
      root: join(dir, name, '.scratch'),
      ref: name === HOME ? '.scratch' : `${name}/.scratch`,
    }))
}
