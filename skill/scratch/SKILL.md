---
name: scratch
description: Ler e escrever os arquivos de trabalho do Arthur (tickets, PRDs, mapas, issues em .md) no scratch remoto pela API scratch-api. Use quando o prompt trouxer uma chave `sk_...` do scratch, mencionar `pessoal/.scratch`, `.scratch/NOME-DO-ESFORCO`, ticket/issue/PRD/mapa do wayfinder, ou pedir para atualizar o Status de um ticket, estando fora da máquina do Arthur (sessão de nuvem).
---

# scratch — tracker remoto

O `.scratch` do Arthur mora na máquina dele; esta API é a única porta de fora. Os `.md` são a
fonte da verdade: o que você grava aparece ao vivo no board que ele olha.

## Acesso

- URL: `${SCRATCH_URL:-https://api-scratch.duenas.dev.br}`
- Chave temporária: `sk_...` — vem no prompt ou em `$SCRATCH_TOKEN`. Vai no header `X-Scratch-Token`.
- Borda: `Authorization: Basic ...`. Normalmente o proxy do ambiente injeta sozinho. Se houver
  `$SCRATCH_EDGE_AUTH` (o valor já em base64), mande `Authorization: Basic $SCRATCH_EDGE_AUTH`.
- Nunca imprima a chave nem o valor da borda em arquivo, commit ou resposta.

```bash
S=${SCRATCH_URL:-https://api-scratch.duenas.dev.br}
H=(-H "X-Scratch-Token: $SCRATCH_TOKEN")
[ -n "$SCRATCH_EDGE_AUTH" ] && H+=(-H "Authorization: Basic $SCRATCH_EDGE_AUTH")
```

## Rotas

```bash
curl -s "${H[@]}" "$S/api/origins"                                  # origens que a chave alcança
curl -s "${H[@]}" "$S/api/tree?ns=pessoal"                          # árvore: rel, title, status, mtime
curl -s -D /tmp/h "${H[@]}" "$S/api/file?ns=pessoal&path=<rel>"      # corpo cru; ETag em /tmp/h
```

`path` é o `rel` da árvore (relativo à raiz da origem, ex. `notinhas-automacao/issues/01-x.md`).

## Escrever — sempre condicionado

1. Leia o arquivo e guarde o ETag (`grep -i '^etag' /tmp/h`).
2. Edite localmente o corpo lido (preserve o que não é seu).
3. Grave:

```bash
# editar: If-Match com o ETag lido
curl -s "${H[@]}" -X PUT -H "If-Match: $ETAG" --data-binary @arquivo.md "$S/api/file?ns=pessoal&path=<rel>"
# criar: If-None-Match: *
curl -s "${H[@]}" -X PUT -H "If-None-Match: *" --data-binary @novo.md "$S/api/file?ns=pessoal&path=<rel>"
```

- `412` = mudou desde a sua leitura (o Arthur ou outro agente escreveu). Releia, reaplique a sua
  mudança sobre o novo, grave de novo. Nunca force.
- Subpastas nascem sozinhas. Só `.md`, `.txt`, `.json`, até 1 MB. Não há apagar nem mover:
  fechar ticket é editar a linha `Status:`.
- Use `--data-binary @arquivo`, nunca `-d` (que come quebras de linha).

## Erros

`401` chave ausente/expirada/revogada (peça outra ao Arthur) · `403` origem fora da chave ·
`404` arquivo ou origem inexistente · `412` conflito · `413` grande demais · `415` extensão ·
`428` faltou `If-Match`/`If-None-Match`. Corpo `Unauthorized` sem JSON = barrado na borda
(falta o header `Authorization: Basic`), não na API.

## Convenções do tracker

- `Status:` canônicos: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
  `wontfix`; wayfinder: `open`, `claimed`, `resolved`.
- Ao pegar um ticket: `Status: claimed`. Ao terminar: `Status: resolved` + uma seção curta do
  que foi feito (commits, branch, o que ficou de fora).
- `Blocked by: NN` referencia irmãos da mesma pasta; só pegue ticket cujo bloqueio está resolvido.
- PT-BR, termos técnicos no original.
