# Identidad y acceso operativo del piloto

El despliegue web del piloto usa dos imágenes del mismo commit y una base SQLite en el volumen del servicio `auth`. El frontend de `web-pilot` exige una sesión antes de iniciar Cockpit. Nginx enruta `/api/` y `/operation/` al servicio interno. El sitio requiere un origen HTTPS. La imagen `web` sigue siendo el build de desarrollo que usa el actual actualizador del servidor.

## Preparación del operador

1. Revisar el PR y elegir un SHA. Etiquetar ambas imágenes con la versión del piloto y el SHA. Definir `COCKPIT_PILOT_REVISION` y los dos nombres de imagen en un archivo privado a partir de [.env.pilot.example](../.env.pilot.example).
2. Generar un keyring fuera del repositorio con un ID de versión y una clave aleatoria de 32 bytes en Base64. El archivo JSON tiene forma `{"active":"v1","keys":{"v1":"<base64>"}}`. Dar acceso de lectura solo al operador y al usuario del contenedor `auth` (UID 1000 en Linux). Resguardar la clave fuera de la copia de la base. Acordar quién puede consultar contraseñas y registrar la aceptación del riesgo de conservar copias reversibles. Las cuentas deben usar claves exclusivas del piloto.
3. Configurar un proyecto Compose separado para staging. Usar un puerto libre y un origen HTTPS de prueba. En producción, limitar los servicios privados del robot y el origen Docker al gateway, con reglas de red verificadas desde la red del cliente. El proceso `auth` no publica puerto. Mantener la terminal PTY fuera del piloto web, ya que ejecuta comandos en el host o por SSH.
4. Publicar las dos imágenes juntas. La tarea `ServerCIT Cockpit AutoUpdate` actual construye `web` desde `main` y reescribe un manifiesto de un servicio. Para el piloto, configurar el actualizador para usar el manifiesto versionado [compose.pilot.yaml](../compose.pilot.yaml), ambas imágenes y un proyecto propio. Mantener el canal del piloto fijado al SHA aprobado. Si se usa el dominio existente, dirigir el túnel al puerto del proyecto piloto solo después de aceptar staging y evitar que el manifiesto anterior vuelva a atender ese origen.

El lanzador [deploy-pilot.ps1](../scripts/deploy-pilot.ps1) es el punto de entrada para programar el piloto en el servidor. Exige el SHA aprobado y un checkout limpio, etiqueta ambas imágenes, comprueba la configuración y verifica que la API exija sesión. Usar primero `-ValidateOnly` para revisar el manifiesto sin arrancar servicios. El operador puede usar el lanzador o ejecutar los pasos de Compose manualmente.

```powershell
docker compose -p cockpit-pilot --env-file .env.pilot -f compose.pilot.yaml config --quiet
docker compose -p cockpit-pilot --env-file .env.pilot -f compose.pilot.yaml build
docker compose -p cockpit-pilot --env-file .env.pilot -f compose.pilot.yaml up -d --no-build --wait
docker compose -p cockpit-pilot --env-file .env.pilot -f compose.pilot.yaml exec auth node server/auth/cli.mjs init-admin <usuario> "<nombre>"
```

La clave temporal dura 24 horas y habilita un único inicio de sesión. Entregarla por un canal privado. El administrador elige una clave propia, enrola el segundo factor y crea una cuenta estándar desde **Usuarios**. Confirmar que el usuario pueda ingresar y que el sitio rechace la API administrativa con su sesión. Para consultas y restablecimientos, usar un código TOTP nuevo. Si se interrumpe el alta o se pierde el autenticador, usar `recover-admin <usuario>` desde una consola de operación autorizada. En una recuperación, pausar el ingreso de tráfico durante la operación, entregar la clave temporal y revisar el evento de auditoría.

## Servicios detrás de la pasarela

| Variable | Destino configurado por el operador |
| --- | --- |
| `COCKPIT_NAVIGATION_URL`, `COCKPIT_SIMULATION_URL`, `COCKPIT_ROSBRIDGE_URL` | URL privada completa de cada WebSocket. Navegación es obligatoria. |
| `COCKPIT_DISPATCH_URL`, `COCKPIT_VISION_URL`, `COCKPIT_PERSON_URL`, `COCKPIT_MJPEG_URL` | URLs privadas completas para despacho HTTP, datos de visión, estado de detección y stream MJPEG. |
| `COCKPIT_CAMERA_URL` | Base privada de MediaMTX WHEP. El gateway espera las rutas `cam3`, `cam4`, `cam5` y sus variantes `_normal`. |
| `COCKPIT_RECORDINGS_URL` | Origen privado dedicado a descargas de grabaciones. La ruta y consulta firmadas del catálogo se reenvían a ese servidor. |

Validar cámaras en la red del cliente. WHEP usa HTTPS a través de Cockpit para negociar y revocar la sesión. El tráfico de medios viaja por ICE. Para habilitarlo, verificar que la entrega de medios esté restringida a sesiones negociadas y que las rutas directas de administración y señalización queden cerradas. Usar MJPEG en el piloto si no se puede validar esa topología. Verificar que suspender una cuenta corta WebSocket y termina las sesiones de video del gateway. Confirmar también que el backend libera el control y aplica su comportamiento previsto cuando se cierra el transporte.

## Copias, rotación y reversión

- Generar una copia coherente con `exec auth node server/auth/cli.mjs backup /tmp/cockpit-<fecha>.sqlite` usando las opciones Compose del despliegue. Extraerla con `docker compose cp`, guardarla cifrada y retirar la copia temporal del contenedor. Resguardar por separado las versiones del keyring requeridas para restaurarla.
- Ensayar la restauración en un proyecto aislado y un volumen nuevo. Con `auth` detenido, colocar la copia como `/data/cockpit.sqlite`, propiedad del UID 1000 y modo 0600. Usar el keyring correspondiente y ejecutar `revoke-sessions` como comando del servicio antes de aceptar tráfico. Confirmar integridad, accesos y cambios de cuentas desde la fecha de la copia.
- Para rotar, bloquear el tráfico y detener `auth`. Agregar la nueva clave al keyring, marcarla activa y mantener las versiones anteriores. Ejecutar `docker compose run --rm --no-deps auth node server/auth/cli.mjs rotate` con las opciones del proyecto. Se recifran las credenciales y se cierran sesiones. Arrancar `auth` con el nuevo keyring y verificar antes de restaurar tráfico. Retener las claves anteriores mientras existan copias que las requieran.
- Ante una reversión, volver al par de imágenes de identidad previo compatible con la base. Si el esquema cambió, restaurar la copia correspondiente en un volumen separado y revocar sesiones. Durante la recuperación, mantener el origen público cerrado o bajo un control de acceso independiente.

## Evidencia y límites

Las claves se verifican con Argon2id. El rol Usuario tiene una copia AES-256-GCM consultable por un administrador tras clave y TOTP. Quedan auditados el actor, la cuenta, la acción y el resultado. Documentar el acceso a la clave de cifrado y el tratamiento de este riesgo para ISO/IEC 27001. Un compromiso simultáneo del servicio y el keyring permite recuperar esas copias. [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) · [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)

Pruebas de aplicación con Node 24. Ejecutar `npm run build`, `npm run test` y `npm run test:auth`. La prueba de identidad usa un robot simulado, dos roles, TOTP, revocación de WebSocket y una copia SQLite restaurada. El corte requiere comprobar el origen HTTPS y la red del cliente.
