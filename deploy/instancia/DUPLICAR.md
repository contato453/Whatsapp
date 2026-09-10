# Duplicar o AZVCHAT — criar uma instância nova na mesma VPS

Passo a passo para subir uma segunda (terceira, quarta) cópia do sistema, com
banco, números de WhatsApp e usuários próprios, na mesma máquina, sem encostar
na que já está atendendo.

O código é o mesmo em todas as cópias. O que separa uma da outra é a
configuração: nome do conjunto de containers, domínios, senhas e volumes.

> **Leia isto antes do primeiro comando.** O ponto mais perigoso desta VPS não
> é subir a cópia nova, é o Caddy (o porteiro que entrega os domínios). Ele é
> único para a máquina inteira, vive no projeto `whatsapp`, e um passo errado
> ali tira do ar o escritório que já está trabalhando. Os passos 5 a 7 tratam
> disso, e explicam o porquê de cada linha.

Tempo estimado: 30 a 40 minutos, quase tudo esperando a construção.

---

## Antes de começar

Escolha um **sufixo** curto, só letras e números, que ainda não exista. A
instância atual é a `azvchat2`, então a próxima natural é `3`. Ele entra no
nome dos containers e vira nome de máquina na rede interna, por isso nada de
traço, sublinhado ou acento.

Este guia usa `3` nos exemplos. Troque pelo seu.

Confirme o que já existe:

```bash
docker compose ls
```

---

## Passo 1 — DNS

No painel do seu domínio, crie **dois registros A** apontando para o IP da
VPS:

| Tipo | Nome | Valor |
| --- | --- | --- |
| A | `app2` | IP da VPS |
| A | `api2` | IP da VPS |

Faça isto primeiro e espere propagar. O certificado HTTPS é emitido
automaticamente, mas só funciona depois que o nome já resolve para a máquina.
Confira com `dig +short app2.seudominio.com.br`.

---

## Passo 2 — Gerar os arquivos da instância

```bash
cd /root/Whatsapp-ajustes

sed 's/__SUF__/3/g' deploy/instancia/docker-compose.instancia.yml \
  > docker-compose.azvchat3.yml

cp deploy/instancia/.env.instancia.example .env.azvchat3
```

Confira que não sobrou nenhum marcador:

```bash
grep -c __SUF__ docker-compose.azvchat3.yml   # tem que dar 0
```

---

## Passo 3 — Preencher as variáveis

```bash
nano .env.azvchat3
```

Os quatro campos obrigatórios estão marcados no arquivo. Gere os segredos, não
invente nem reaproveite:

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 48   # JWT_SECRET
```

`APP_DOMAIN` e `API_DOMAIN` são os dois nomes do passo 1, **sem `https://`**.

> **Confira o `API_DOMAIN` com atenção.** Ele é gravado dentro do site na hora
> de construir, não lido quando ele roda. Errado aqui, o sintoma aparece só no
> fim, como "o sistema não conecta", e a correção é construir tudo de novo.

Guarde uma cópia deste arquivo fora da VPS. Ele não está no Git, e é a única
receita de como a instância sobe.

---

## Passo 4 — Construir e subir

```bash
docker compose -f docker-compose.azvchat3.yml --env-file .env.azvchat3 up -d --build
```

Demora alguns minutos. A instância que já está no ar **não é afetada**: são
containers, volumes e rede próprios, com nome diferente.

Confira que os três subiram:

```bash
docker compose -f docker-compose.azvchat3.yml --env-file .env.azvchat3 ps
```

As tabelas são criadas sozinhas quando a API sobe. Se o log mostrar
`api_started`, o banco está pronto.

Neste ponto a instância está rodando, mas **ninguém consegue acessar ainda**:
ela não publica porta nenhuma, de propósito. Quem entrega os domínios é o
Caddy, e é o que vem agora.

---

## Passo 5 — Ligar o Caddy à rede da instância nova

```bash
docker network connect azvchat3_default whatsapp-caddy-1
```

Sem isto o Caddy não tem como alcançar os containers novos, e o domínio
responderia erro 502.

> Esta conexão é feita na mão e **não fica gravada em arquivo nenhum**. Ela
> sobrevive a `docker restart`, mas se o container do Caddy for APAGADO e
> recriado, ela se perde junto com as das outras instâncias, e todos os
> domínios caem. Se isso acontecer, o conserto é repetir este comando para
> cada rede: `azvchat2_default`, `azvchat3_default`, `astracalls_default`.

---

## Passo 6 — Acrescentar os domínios ao Caddy

O arquivo fica na pasta antiga, que é onde o container do Caddy nasceu:

```bash
nano /root/Whatsapp/deploy/Caddyfile
```

Acrescente no fim, **sem apagar nada do que já está lá**:

```
# ==============================================================
# Instância azvchat3.
# ==============================================================
app2.seudominio.com.br {
        encode gzip
        reverse_proxy azvweb3:3000
}

api2.seudominio.com.br {
        encode gzip
        # WebSockets (Socket.IO) passam automaticamente pelo reverse_proxy
        reverse_proxy azvapi3:4000
}
```

> **Nunca rode `git checkout`, `git restore` ou `git pull` dentro de
> `/root/Whatsapp`.** Este arquivo foi editado à mão e a versão do Git não tem
> nenhum destes blocos. Um comando de git ali apaga a configuração de todos os
> domínios, e o estrago só aparece no próximo reinício do Caddy, bem depois de
> alguém conseguir ligar uma coisa à outra.

---

## Passo 7 — Recarregar o Caddy

```bash
docker restart whatsapp-caddy-1
```

`restart` preserva as redes ligadas no passo 5. **Não use `docker compose up`
nem `down` na pasta `/root/Whatsapp`**: aquilo recria o container, perde as
conexões de rede e derruba tudo.

A porta de administração do Caddy está desativada nesta máquina, então
`caddy reload` não funciona. O `restart` é o caminho certo, e é seguro porque
a configuração inteira está no arquivo em disco.

O certificado HTTPS dos domínios novos é emitido em alguns segundos.

---

## Passo 8 — Criar o primeiro administrador

A instância nasce com o banco vazio, sem nenhum usuário. Crie o seu **já com
senha de verdade**:

```bash
docker compose -f docker-compose.azvchat3.yml --env-file .env.azvchat3 exec \
  -e SEED_ADMIN_EMAIL='voce@seudominio.com.br' \
  -e SEED_ADMIN_PASSWORD='uma-senha-forte-aqui' \
  -e SEED_ADMIN_NAME='Seu Nome' \
  azvapi3 pnpm --filter @azvchat/database seed
```

> Rodando sem estas três variáveis, o sistema cria `admin@example.com` com a
> senha `admin123`. Num endereço público, é uma porta aberta.

---

## Passo 9 — Conferir

```bash
curl -sS -o /dev/null -w 'app2 %{http_code}\n' https://app2.seudominio.com.br
curl -sS -o /dev/null -w 'api2 %{http_code}\n' https://api2.seudominio.com.br/health
```

E, principalmente, confira que a instância ANTIGA continua respondendo:

```bash
curl -sS -o /dev/null -w 'app  %{http_code}\n' https://app.azvchat.com.br
curl -sS -o /dev/null -w 'api  %{http_code}\n' https://api.azvchat.com.br/health
```

Os quatro devem responder `200`. Entre no endereço novo, faça login e conecte
os números de WhatsApp da cópia por QR Code, em Conexões.

---

## Atualizar as instâncias depois

Uma cópia **não** se atualiza sozinha junto com a outra. Cada uma é subida
pelo seu próprio arquivo:

```bash
cd /root/Whatsapp-ajustes
git fetch origin claude/whatsapp-support-platform-ezyvx0
git checkout claude/whatsapp-support-platform-ezyvx0
git merge --ff-only origin/claude/whatsapp-support-platform-ezyvx0

# uma linha por instância
docker compose -f docker-compose.azvchat2.yml --env-file .env.azvchat2 up -d --build
docker compose -f docker-compose.azvchat3.yml --env-file .env.azvchat3 up -d --build
```

O `deploy/atualizar.sh` cuida só da `azvchat2`. Para as demais, o comando é
manual, ou o script recebe as variáveis `DEPLOY_COMPOSE`, `DEPLOY_ENV_FILE` e
`DEPLOY_API_SERVICE`.

---

## Backup, por instância

Cada cópia tem o banco dela. O backup também:

```bash
docker exec azvchat3-azvpg3-1 sh -c 'pg_dumpall -U "$POSTGRES_USER"' \
  > /root/backup-azvchat3-$(date +%F).sql

tail -c 100 /root/backup-azvchat3-*.sql   # tem que terminar em "dump complete"
```

Backup que ninguém conferiu não conta como backup, e backup no mesmo disco do
banco protege contra erro humano, não contra o disco morrer. Copie para fora
da VPS.

---

## O que NÃO fazer

| Nunca | Por quê |
| --- | --- |
| `docker compose up` ou `down` em `/root/Whatsapp` | Recria o Caddy, perde as redes ligadas e derruba TODOS os domínios |
| `git checkout`/`pull` em `/root/Whatsapp` | Apaga os blocos de domínio do `Caddyfile`, escritos à mão |
| Usar `docker-compose.prod.yml` | É a stack morta; declara um Caddy que disputa a porta 443 |
| Repetir o sufixo entre instâncias | O endereço do container fica ambíguo e o Caddy entrega o cliente de um escritório na tela do outro |
| Repetir `JWT_SECRET` entre instâncias | O login de uma cópia passa a ser aceito pela outra |
