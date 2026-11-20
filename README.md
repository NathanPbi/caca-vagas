# Caça-vagas

Página que monta buscas prontas de vagas de emprego em 30 fontes: grandes portais, sistemas de recrutamento das empresas (vagas "escondidas"), anúncios gratuitos em redes sociais e grupos, estágio e concursos.

É um site estático: um único `index.html`, sem build e sem backend.

## Rodar localmente

Abra o `index.html` no navegador, ou:

```bash
npx serve .
```

## Publicar no servidor (Nginx)

```bash
sudo mkdir -p /var/www/caca-vagas
sudo git clone https://github.com/NathanPbi/caca-vagas.git /var/www/caca-vagas
sudo cp /var/www/caca-vagas/deploy/nginx.conf /etc/nginx/sites-available/caca-vagas
sudo ln -s /etc/nginx/sites-available/caca-vagas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Para atualizar depois: `cd /var/www/caca-vagas && sudo git pull`.

> O botão "Sugerir cargos parecidos com IA" só aparece quando a página roda dentro do Claude. No servidor próprio ele fica oculto e o resto funciona normalmente.
