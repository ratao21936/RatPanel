# Como instalar e configurar o RatPanel

Tutorial completo pra instalar o painel e configurar tudo corretamente.

---

## ⚡ Instalação automática (recomendado)

Em qualquer VPS ou máquina Linux/macOS, rode:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ratao21936/RatPanel/main/install.sh)
```

O instalador faz **tudo automaticamente**:

- ✅ Verifica se o Node.js 18+ está instalado
- ✅ Clona o repositório
- ✅ Instala as dependências
- ✅ **Gera um `JWT_SECRET` aleatório e seguro**
- ✅ Cria o arquivo `.env` com a porta que você escolher
- ✅ Pergunta se quer iniciar o painel agora

**Você não precisa criar nenhum arquivo manualmente.**

---

## 🔧 Instalação manual

Se preferir instalar na mão:

### 1. Clonar o repositório

```bash
git clone https://github.com/ratao21936/RatPanel.git
cd RatPanel/backend
```

### 2. Instalar dependências

```bash
npm install
```

### 3. Criar o arquivo `.env`

Crie um arquivo `.env` dentro da pasta `backend/` com este conteúdo:

```env
PORT=6002
JWT_SECRET=cole_aqui_a_chave_gerada_no_proximo_passo
```

### 4. Gerar um `JWT_SECRET` seguro

O `JWT_SECRET` é a chave que assina os tokens de login. **Ele precisa ser aleatório e secreto** — se alguém descobrir, pode forjar login de admin no seu painel.

Gere um com Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Vai sair algo assim:

```
8f4a2b9c1d7e3f5a6b8c0d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f
```

Cole esse valor no `.env`, na linha `JWT_SECRET=`.

### 5. Iniciar o painel

```bash
npm start
```

### 6. Abrir no navegador

```
http://localhost:6002/login.html
```

> Se você mudou a `PORT` no `.env`, use a porta que você definiu.

**Login padrão:** `admin` / `admin123`
🔴 **Troque a senha imediatamente após o primeiro login!**

---

## 🔑 Sobre o `JWT_SECRET`

### O que é?

É a chave secreta usada pra assinar e verificar os tokens de login dos usuários. Toda vez que alguém loga no painel, o servidor gera um token JWT assinado com essa chave.

### Por que preciso trocar?

Se alguém souber o seu `JWT_SECRET`, essa pessoa pode:

- 🔴 Forjar um token de login e entrar como **admin**
- 🔴 Modificar tokens existentes
- 🔴 Burlar a autenticação do painel inteiro

**Nunca use o valor padrão ou um valor previsível.**

### Onde fica?

No arquivo `backend/.env`:

```env
PORT=6002
JWT_SECRET=sua_chave_aqui
```

### Como gerar um?

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cada execução gera um valor único. Copie e cole no `.env`.

### Como trocar depois?

1. Abra o `backend/.env`
2. Substitua o valor depois de `JWT_SECRET=`
3. Reinicie o painel:
   ```bash
   # Pare com Ctrl+C e rode de novo
   npm start
   ```

> ⚠️ **Ao trocar o `JWT_SECRET`, todos os usuários logados serão deslogados.** Isso é normal — eles precisam fazer login de novo.

### E se eu perder o `JWT_SECRET`?

Sem problema. Gere um novo e cole no `.env`. Só vai invalidar as sessões ativas.

---

## 🔒 Segurança — depois do primeiro acesso

Vá em **Settings** e faça:

1. ✅ Troque a senha do `admin`
2. ✅ Ative **Two-Factor Authentication (2FA)**
3. ✅ Configure o **webhook do Discord** se quiser receber alertas
4. ✅ Confirme que o `JWT_SECRET` é aleatório (não deixe valor de exemplo)

---

## 🐛 Problemas comuns

### "Porta já em uso"
Outra aplicação está usando a porta `6002`. Abra o `.env` e mude para outra:

```env
PORT=6003
```

Reinicie o painel.

### "Não consigo logar"
- Confirme que o `.env` existe (`ls backend/.env`)
- Confirme que o `JWT_SECRET` está definido
- Se você apagou o `users.json`, reinicie o painel — ele recria o admin padrão automaticamente
- Tente limpar o cache do navegador

### "Node.js not found"
Instale o Node.js 18+:

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node
```

Confirme:
```bash
node -v   # deve mostrar v18 ou superior
```

### "Permission denied" ao rodar o `install.sh`
Dê permissão de execução:

```bash
chmod +x install.sh
./install.sh
```

### "Falha ao clonar o repositório"
Verifique sua conexão ou se o Git está instalado:
```bash
git --version
```

---

## 🖥️ Rodar em background (Linux/VPS)

Pra deixar o painel rodando mesmo depois de fechar o terminal, use `pm2`:

```bash
npm install -g pm2
cd backend
pm2 start server.js --name ratpanel
pm2 save
pm2 startup
```

Comandos úteis:

```bash
pm2 status            # ver status
pm2 logs ratpanel     # ver logs em tempo real
pm2 restart ratpanel  # reiniciar
pm2 stop ratpanel     # parar
pm2 delete ratpanel   # remover do pm2
```

---

## 📂 Estrutura do projeto

```
RatPanel/
├── backend/          # Servidor Node.js (Express + WebSocket)
├── frontend/         # Interface web (HTML)
├── docs/             # Imagens do README
├── install.sh        # Instalador automático
├── INSTALL.md        # Este arquivo
└── README.md         # Visão geral do projeto
```

---

## 📝 Resumo rápido

| Passo | Comando |
|---|---|
| Instalar (auto) | `bash <(curl -fsSL .../install.sh)` |
| Instalar (manual) | `git clone ... && cd backend && npm install` |
| Gerar JWT | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Iniciar | `npm start` |
| Acessar | `http://localhost:6002/login.html` |
| Login padrão | `admin` / `admin123` |

---

Pronto! Se tiver algum problema, abra uma [issue](https://github.com/ratao21936/RatPanel/issues).
