# Sistema Inventario

Aplicacion web de inventario (Admin, Supervisor de PFA, Tecnico de PFA y Tecnico de Instrumentacion) con backend en Node.js + Express y base de datos PostgreSQL.

## Requisitos

- Node.js 20+
- PostgreSQL

## Configuracion local

1. Instala dependencias:

```bash
npm install
```

2. Crea tu archivo `.env` tomando como base `.env.example`:

```env
PORT=3000
DB_USER=postgres
DB_PASSWORD=tu_password
DB_HOST=localhost
DB_PORT=6000
DB_NAME=sistema_inventario
DB_SSL=false
```

3. Inicia el servidor:

```bash
npm start
```

4. Abre:

`http://localhost:3000/login.html`

## Scripts

- `npm start` -> levanta el servidor
- `npm run dev` -> levanta el servidor (modo simple)

## Subir a GitHub (paso a paso)

1. Inicializa git (si aun no lo tienes):

```bash
git init
```

2. Agrega remoto:

```bash
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
```

3. Revisa cambios:

```bash
git status
```

4. Commit:

```bash
git add .
git commit -m "Proyecto listo para publicacion"
```

5. Sube rama principal:

```bash
git branch -M main
git push -u origin main
```

## Seguridad

- No subas tu `.env` al repositorio.
- Las credenciales de BD ya se leen por variables de entorno.
- Este proyecto incluye `.gitignore` para evitar subir archivos sensibles y respaldos.
