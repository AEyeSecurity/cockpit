# Camera workspace

The Camera workspace displays a large fixed panoramic feed above two smaller
secondary feeds: mobile and reverse. The map camera remains the principal feed.

Nav2 package settings:

- `camera_webrtc_url`: principal panorama (MediaMTX `cam3`).
- `camera_mobile_webrtc_url`: mobile secondary (MediaMTX `cam4`); starts on request.
- `camera_reverse_webrtc_url`: future rear camera; empty shows a placeholder.
  Once configured, it starts automatically while the Camera workspace is open.
- `camera_ptz_enabled`: enables the existing PTZ controls/polling; true for the
  Uniarch mobile lens ONVIF deployment. Video is independent.

Streams unmount on leaving the workspace. MediaMTX paths use sourceOnDemand.
Both Uniarch lenses use H.264 secondary feeds, 640x360 / 15 FPS / 256 kbit/s each.
Two simultaneous feeds add network traffic. Rear camera hardware is not integrated yet. Uniarch mobile PTZ uses arrows and
four editable directional views; camera_ptz_zoom_enabled=false hides unvalidated zoom.
Saved directional views need calibration to the installed robot orientation.
