# Caça-vagas

Reúne vagas de emprego de várias fontes numa lista só, dentro da própria página, e ainda monta buscas prontas em 30 sites (portais, sistemas de recrutamento das empresas, grupos e redes sociais).

## Busca pelo currículo

Na aba **Enviar currículo**, a pessoa envia um PDF, um .docx ou cola o texto. O arquivo é lido no navegador e só o texto vai para o servidor, que não guarda nada. O servidor identifica cargos, habilidades e cidade. Por padrão ele usa regras automáticas e, se houver `ANTHROPIC_API_KEY` no `.env`, usa IA. A pessoa pode ajustar o perfil antes de buscar. Depois o servidor busca as vagas pelos 4 primeiros cargos e dá a cada uma uma nota de compatibilidade (0–100%) pelo título e pelas habilidades citadas no anúncio.

## Fontes da lista integrada

| Fonte | Precisa de chave? | O que traz |
|---|---|---|
| Gupy | Não | Vagas de milhares de empresas que usam a Gupy |
| Sites de empresas | Sim: `SERPER_KEY`, 2.500 consultas grátis em serper.dev | Páginas "Trabalhe conosco" e sistemas como Sólides, InHire, Kenoby, Lever |
| Google Vagas | Sim: `SERPAPI_KEY`, 250 buscas grátis/mês em serpapi.com | O painel de vagas do Google, que junta dezenas de sites |
| Adzuna | Sim, grátis em developer.adzuna.com | Vagas agregadas de vários portais brasileiros |
| Jooble | Sim, grátis em br.jooble.org/api/about | Vagas agregadas de vários portais brasileiros |

Sem chaves, a lista funciona só com a Gupy. Para ligar as outras, copie `.env.example` para `.env` e preencha.

A inscrição sempre acontece no site de origem da vaga. Grupos de Facebook, Instagram e LinkedIn não oferecem dados abertos, por isso aparecem como buscas prontas.

## Rodar localmente

Requer Node.js 18 ou mais novo. Não tem dependências para instalar.

```bash
node server.js
```

Abra http://localhost:8085.

## Publicar no servidor (achevagas.monitor.ind.br)

```bash
sudo apt update && sudo apt install -y nodejs git   # Node 18+
sudo git clone https://github.com/NathanPbi/caca-vagas.git /var/www/caca-vagas
sudo cp /var/www/caca-vagas/.env.example /var/www/caca-vagas/.env   # edite se tiver chaves
sudo cp /var/www/caca-vagas/deploy/caca-vagas.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now caca-vagas
curl -s http://localhost:8085/api/status
```

Na Cloudflare (Zero Trust → Networks → Tunnels → seu túnel → Public Hostname), aponte `achevagas.monitor.ind.br` para `http://localhost:8085`.

### Atualizar

```bash
cd /var/www/caca-vagas && sudo git pull && sudo systemctl restart caca-vagas
```
