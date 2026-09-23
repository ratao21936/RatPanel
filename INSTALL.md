# Como configurar o RatPanel

Tutorial básico pra você configurar o painel depois de clonar o repositório.

---

## ⚡ Instalação automática (recomendado)

Rode este comando em qualquer VPS ou máquina Linux/macOS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ratao21936/RatPanel/main/install.sh)
```

O instalador faz tudo: verifica o Node, clona o repo, instala as dependências, cria o `.env` com um `JWT_SECRET` aleatório e inicia o painel.

---

## 🔧 Instalação manual

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

```bash
cp .env.example .env
```

### 4. Editar o `.env`

Abra o arquivo `backend/.env` e configure:

| Variável | Descrição | Exemplo |
|---|---|---|
| `PORT` | Porta do servidor | `6002` |
| `JWT_SECRET` | Chave secreta para assinar tokens (obrigatório trocar) | `a1b2c3d4e5f6...` |

**Como gerar um `JWT_SECRET` seguro:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cole o resultado no `.env`. Ele deve ficar mais ou menos assim:

```env
PORT=6002
JWT_SECRET=8f4a2b9c1d7e3f5a6b8c0d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f
```

> ⚠️ **Nunca** suba o `.env` para o GitHub. Ele já está no `.gitignore`.

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

## 🔒 Segurança — leia isso

Depois do primeiro acesso, vá em **Settings** e faça:

1. ✅ Troque a senha do `admin`
2. ✅ Ative **Two-Factor Authentication (2FA)**
3. ✅ Configure o **webhook do Discord** se quiser receber alertas
4. ✅ Verifique se o `JWT_SECRET` no `.env` é aleatório (não deixe o padrão)

---

## 🐛 Problemas comuns

### "Porta já em uso"
Outra aplicação está usando a porta `6002`. Abra o `.env` e mude para outra:

```env
PORT=6003
```

### "Não consigo logar"
- Verifique se o `.env` existe (`ls backend/.env`)
- Confirme que o `JWT_SECRET` está definido
- Se você apagou o `users.json`, reinicie o painel — ele recria o admin padrão automaticamente

### "Node.js not found"
Instale o Node.js 18+:

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node
```

Confirme a versão:
```bash
node -v   # deve mostrar v18 ou superior
```

### "Permission denied" ao rodar o install.sh
Dê permissão de execução:

```bash
chmod +x install.sh
./install.sh
```

---

## 🖥️ Rodar em background (Linux/VPS)

Se quiser que o painel continue rodando depois de fechar o terminal, use `pm2`:

```bash
npm install -g pm2
cd backend
pm2 start server.js --name ratpanel
pm2 save
pm2 startup
```

Comandos úteis:
```bash
pm2 status          # ver status
pm2 logs ratpanel   # ver logs
pm2 restart ratpanel
pm2 stop ratpanel
```

---

## 📂 Estrutura do projeto

```
RatPanel/
├── backend/          # Servidor Node.js
├── frontend/         # Interface web
├── docs/             # Imagens do README
├── install.sh        # Instalador automático
├── INSTALL.md        # Este arquivo
└── README.md         # Visão geral do projeto
```

---

Pronto! Se tiver algum problema, abra uma [issue](https://github.com/ratao21936/RatPanel/issues).
