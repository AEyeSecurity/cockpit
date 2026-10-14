# Camera workspace

The Camera workspace displays a large fixed panoramic feed above two smaller
secondary feeds: mobile and reverse. The map camera remains the principal feed.

Nav2 package settings:

- `camera_webrtc_url`: principal panorama (MediaMTX `cam3`).
- `camera_mobile_webrtc_url`: mobile secondary (MediaMTX `cam4`); starts on request.
- `camera_reverse_webrtc_url`: rear camera (MediaMTX `cam5`); empty shows a placeholder.
  Once configured, it starts automatically while the Camera workspace is open.
- `camera_ptz_enabled`: enables the existing PTZ controls/polling; true for the
  Uniarch mobile lens ONVIF deployment. Video is independent.

Streams unmount on leaving the workspace. MediaMTX paths use sourceOnDemand.
Both Uniarch lenses use H.264 secondary feeds, 640x360 / 15 FPS / 256 kbit/s each.
Two simultaneous feeds add network traffic. The UNV rear camera is integrated as `cam5`. Uniarch mobile PTZ uses arrows and
four editable directional views; camera_ptz_zoom_enabled=false hides unvalidated zoom.
Saved directional views need calibration to the installed robot orientation.

`camera_ptz_pan_inverted=true` corrects the Uniarch horizontal arrow direction,
including diagonals, without changing vertical motion or saved preset positions.
It is independent of the mounting rotation.

## Rear camera deployment — 2026-10-10

UNV IPC2122LB-AF28WK-G (MAC c4:79:05:cb:a7:df), static IPv4
192.168.1.251/24, gateway 192.168.1.1; outside the verified router DHCP
pool .2–.244. Previous DHCP address: .58. Secondary `/media/video2`
uses H.264 Main, 640×360, 15 FPS, configured 256 kbit/s, GOP 30.
MediaMTX relays directly without transcoding; cam5 opens on demand and closes
after 10 seconds without readers. Rear video starts automatically while the
Camera workspace is mounted and releases its reader on leaving the workspace.
Private credentials, relay configuration and rollback copies remain on Jetson.
Power-cycle persistence and measured total link consumption remain unverified.

Validation: ONVIF GET confirmed the encoder settings after persistent SET;
MediaMTX reported H.264/G.711 and a connected WebRTC reader. Browser video
was 640×360, readyState=4 with increasing playback time. Audio G.711 remains
present, so 256 kbit/s is not a total link budget. Build passed; frontend tests
198 passed/1 skipped. The previous panorama/mobile camera at .250 was
unreachable during this check; its existing configuration was preserved.
# Paneo y luces — 2026-10-14

El módulo Camera añade iniciar/detener paneo completo izquierdo→derecho de la
móvil y encender/apagar luz fija para ambas lentes. API WebSocket:
`get_camera_features`, `camera_sweep {enabled}` y
`camera_light {lens: fixed|mobile, enabled}`. El backend es responsable del
recorrido y renovación; abandonar la vista no apaga las luces.
Encendido/inicio requiere control del operador. Apagado/detención no requiere
lease y sigue accesible conectado aunque el estado previo sea desconocido.
Estado de luces: última orden reconocida, sin lectura óptica garantizada.

La luz móvil selecciona blanco y fuerza noche; apagar restaura el perfil previo.
La fija usa la orden manual temporal renovada. Antes de usar en robot real,
desplegar el backend con CameraFeatures; la UI se degrada sin ese servicio.
El método físico de ambas luces se confirmó con operador; el paneo automático
nuevo todavía necesita aceptación física. No se compiló Tauri.
