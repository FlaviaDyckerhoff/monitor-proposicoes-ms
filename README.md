# 🏛️ Monitor Proposições MS — ALEMS

Monitora automaticamente o SGPL da Assembleia Legislativa de Mato Grosso do Sul e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script chama a API interna do SGPL (`sgpl.consulta.al.ms.gov.br/sgpl-publico/hal/public`)
3. Compara as proposições recebidas com as já registradas no `estado.json`
4. Se há proposições novas → envia email com a lista organizada por tipo
5. Salva o estado atualizado no repositório

---

## API utilizada

```
URL Base:  https://sgpl.consulta.al.ms.gov.br/sgpl-publico/hal/public
Endpoint:  GET /proposicao?direction=desc&page=1&size=100&sort=dataLeitura
Formato:   JSON (Spring Page ou HAL _embedded)
Auth:      Nenhuma (API pública)
```

Campos principais na resposta:
- `id` — identificador único da proposição
- `protocolo` — número/ano (ex: "00782/2026")
- `tipo` — sigla do tipo ("P", "PL", etc.)
- `autores` — nome do(s) autor(es)
- `dataLeitura` — data de leitura em plenário
- `resumo` — ementa da proposição
- `visivel` — "S" para visível, "N" para oculta

---

## Estrutura do repositório

```
monitor-proposicoes-ms/
├── monitor.js                      # Script principal
├── package.json                    # Dependências (só nodemailer)
├── estado.json                     # Estado salvo automaticamente pelo workflow
├── README.md                       # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml             # Workflow do GitHub Actions
```

---

## Setup — Passo a Passo

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Procure por **"Senhas de app"** e clique.

**1.4** Digite um nome (ex: `monitor-alems`) e clique em **Criar**.

**1.5** Copie a senha de **16 letras** gerada — ela só aparece uma vez.

> Se já tem senha de app de outro monitor, pode reutilizar.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **+ → New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-ms`
- **Visibility:** Private

**2.3** Clique em **Create repository**

---

### PARTE 3 — Fazer upload dos arquivos

**3.1** Clique em **"uploading an existing file"**

**3.2** Faça upload de:
```
monitor.js
package.json
README.md
```
Clique em **Commit changes**.

**3.3** Clique em **Add file → Create new file**, digite:
```
.github/workflows/monitor.yml
```
Cole o conteúdo do `monitor.yml` e clique em **Commit changes**.

---

### PARTE 4 — Configurar os Secrets

**4.1** No repositório: **Settings → Secrets and variables → Actions**

**4.2** Crie os 3 secrets:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail |
| `EMAIL_SENHA` | senha de 16 letras (sem espaços) |
| `EMAIL_DESTINO` | email de destino dos alertas |

---

### PARTE 5 — Testar

**5.1** Vá em **Actions → Monitor Proposições MS → Run workflow → Run workflow**

**5.2** Aguarde ~15 segundos. Verde = funcionou.

**5.3** O **primeiro run** envia email com todas as proposições recentes e salva o estado. A partir do segundo run, só envia se houver novidades.

---

## Email recebido

O email chega organizado por tipo, com protocolo em ordem decrescente:

```
🏛️ ALEMS — 3 nova(s) proposição(ões)

P — 2 proposição(ões)
  00782/2026 | Dep. Fulana     | 01/04/2026 | Inclui no Calendário...
  00781/2026 | Dep. Ciclano    | 01/04/2026 | Dispõe sobre...

PL — 1 proposição(ões)
  00123/2026 | Dep. Beltrano   | 01/04/2026 | Altera a Lei nº...
```

---

## Horários de execução

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00       | 0 11 * * * |
| 12:00       | 0 15 * * * |
| 17:00       | 0 20 * * * |
| 21:00       | 0 0 * * *  |

---

## Resetar o estado

Para forçar o reenvio de tudo (útil para testar):

1. No repositório, clique em `estado.json` → lápis
2. Substitua o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode o workflow manualmente

---

## Problemas comuns

**Log mostra estrutura desconhecida**
→ A API mudou o formato de resposta. Abra o DevTools na aba Network no SGPL e verifique o endpoint atual.

**Erro "Authentication failed"**
→ `EMAIL_SENHA` colado com espaços. Remova e cole novamente.

**Rodou verde mas não veio email**
→ Verifique o spam. Se nada, veja o log em Actions por `❌` ou `⚠️`.
