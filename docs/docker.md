# Web app con Docker (Windows o Linux)

Docker Desktop debe usar contenedores Linux. No hace falta instalar Node,
Rust ni las dependencias gráficas de Tauri en Windows.

Desde la carpeta del repositorio:

```powershell
docker compose up -d --build
```

Abrir http://localhost:5173. Se compila React/Vite con Node 24 y se sirve
el resultado estático con Nginx. No se compila ni ejecuta Tauri.
El puerto se publica solo en este equipo.

## Dominio público

Publicado el 2026-10-22: https://rover.seguridadautonoma.com

- Cloudflare Tunnel existente: `Bot CSS` (`8a182973-237c-466c-9765-dc164c68c233`).
- Conector Docker: `bot-ccs-cloudflared-1`.
- Origen de la ruta: `http://host.docker.internal:5173`.
- DNS CNAME creado por Cloudflare hacia el túnel, con proxy HTTPS.
- La disponibilidad pública depende de que el conector y `cockpit-web-1`
  permanezcan activos en este equipo.
- Se publica la web; la terminal opcional no está enrutada por este dominio.


```powershell
docker compose logs --tail 100 web
docker compose down
```

## Conexión al robot y cámaras

La imagen usa los valores de `.env.example` durante la compilación. Para
cambiar los valores iniciales `VITE_*`, editar ese archivo y volver a ejecutar
`docker compose up -d --build`. Son valores públicos incorporados en el
JavaScript: no incluir secretos. Un `.env` de Compose no cambia automáticamente
la configuración ya compilada de Vite.

Las conexiones WebSocket, HTTP y cámaras se abren desde el navegador.
`localhost` se refiere al equipo donde se abre ese navegador. Para un robot
en la red, usar su IP o nombre accesible desde Windows. Las opciones de
conexión disponibles en la interfaz también permiten ajustar el destino.
El backend SALUS/ROS y los servidores de cámara no están incluidos aquí.
Algunos endpoints de visión conservan `localhost:8088` en el código original.

Las rutas guardadas se conservan en el almacenamiento del navegador;
usar siempre el mismo origen (por ejemplo, `http://localhost:5173`).

## Terminal opcional

La web puede abrirse sin este servicio. Para habilitar la terminal integrada:

```powershell
docker compose --profile terminal up -d --build
```

La terminal local ejecuta Bash dentro de un contenedor Debian como usuario
`node`; no es una consola de Windows ni del robot. Su directorio personal
persiste en el volumen `terminal-home`. El WebSocket en 127.0.0.1:7681
no tiene autenticación y debe mantenerse local.

La opción de terminal remota SALUS necesita configurar SSH dentro de ese
contenedor (destino, claves y known_hosts). Puede establecerse
`PTY_REMOTE_HOST=usuario@IP` en un `.env` de Compose. No se copian credenciales
del equipo automáticamente.

Para detener también la terminal:

```powershell
docker compose --profile terminal down
```

## Validación en Linux

```powershell
docker build --target test -t cockpit-tests .
docker run --rm cockpit-tests
```

La construcción ejecuta `npm run build`; el contenedor de pruebas ejecuta
`npm run test`. No se compila Tauri.
