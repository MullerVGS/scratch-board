# scratch-board

Board de leitura para os diretórios `.scratch/` dos seus repositórios — os esforços em curso, os documentos de cada um, e o comando que destrava o próximo passo.

Um esforço é uma pasta com um `PRD.md`, um `map.md` e issues numeradas. O board varre tudo, mostra em que estado cada coisa está, e deixa você ler o documento sem sair da página.

- **Uma aba por origem**: cada `.scratch/` montado é um board completo e isolado — mesmo grafo, mesma gaveta, mesmo push. Dois esforços de nome igual em repositórios diferentes são dois esforços. Somar um repositório é somar um mount; não há lista a manter em lugar nenhum.
- **Esforços** com título e resumo, para lembrar do que se trata sem abrir o arquivo.
- **Issues** com status, bloqueios e o `Blocked by:` como link para a issue bloqueante.
- **Grafo de dependências** por esforço: as setas do `Blocked by:` com a profundidade no eixo X, em vez do tempo que o `.scratch/` não tem. A primeira coluna é a frontier; o que já fechou fica esmaecido, mostrando o que soltou o resto.
- **Gaveta** que renderiza o markdown, navega pelos links relativos entre documentos e volta pela trilha — e que é **viva**: quando o agente escreve o arquivo que você está lendo, o conteúdo troca sozinho, preservando a rolagem.
- **Comando por estado**: cada esforço e cada issue mostram, pronto para copiar, o comando que os move — e o que está bloqueado não mostra nenhum.

Esse último ponto é o encaixe com o [mattpocock/skills](https://github.com/mattpocock/skills): `wayfinder`, `to-tickets`, `triage`, `implement`. O board conhece o vocabulário delas e monta a invocação com os caminhos certos; quem decide rodar é você.

## As origens

O board não tem *um* `.scratch/`: ele tem os que estiverem montados sob um diretório comum, e **o compose é a configuração inteira**.

```yaml
- ../.scratch:/workspace/scratches/projetos:ro
- ../vend-server/.scratch:/workspace/scratches/vend-server:ro
```

Cada filho direto é uma origem, e o nome da pasta é o nome dela. Um mount novo vira uma aba nova no próximo start — sem env, sem arquivo de config, sem uma segunda lista para divergir da primeira.

O nome também decide o caminho que você copia. Os comandos partem de `/root/projetos`, então a origem de casa produz `.scratch/...` e qualquer outra produz `<nome>/.scratch/...`; o caminho interno do container nunca aparece na tela.

Cada origem tem watcher, cache e varredura próprios. O navegador mantém **uma** conexão, e cada evento diz de qual origem fala — uma escrita num repositório atualiza a aba dele **sem redesenhar** a que você está lendo, e ela já chega pronta quando você troca de aba.

## Os `.md` são a fonte da verdade

Não há banco nem índice, e o board **não escreve** — nem um byte. Quem muda status é você, ou a skill que resolveu o ticket, no arquivo. Todo `.scratch/` sobe montado read-only para que isso seja uma garantia, não uma promessa.

E o board não pergunta ao disco: ele **é avisado**. Um `fs.watch` vê o arquivo tocar o disco, o servidor remonta a projeção e empurra por SSE — mas **só se ela mudou de verdade**. Nada de polling, nada de refresh, nada de piscar a tela para redesenhar o mesmo pixel. Existe cache, e ele é *derivado*: nenhuma rota o serve sem reler o disco. Um push pode falhar em silêncio, então há rede: uma varredura de segurança, um indicador de conexão que admite quando não sabe, e um botão de reler.

O que ele mecaniza é o que é determinístico: ler o estado, resumir o documento, compor o comando. O julgamento fica de fora.
