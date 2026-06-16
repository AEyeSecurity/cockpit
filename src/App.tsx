import { useEffect, useState } from 'react';
import { CameraPanel } from './components/CameraPanel';
import { IntroAnimation } from './components/IntroAnimation';
import { CameraPTZ } from './components/CameraPTZ';
import { DetectionsPanel } from './components/DetectionsPanel';
import { IconRail } from './components/IconRail';
import { MapView } from './components/MapView';
import { MissionStatus } from './components/MissionStatus';
import { NavPanel } from './components/NavPanel';
import { StatusBar } from './components/StatusBar';
import { TelemetryPanel } from './components/TelemetryPanel';
import { TopBar } from './components/TopBar';
import { useRobotState } from './hooks/useRobotState';
import type { LatLng } from './types';

type MapMode = 'idle' | 'addWaypoint' | 'goal';

export default function App() {
  const robot = useRobotState();
  const [mapMode, setMapMode] = useState<MapMode>('idle');
  // Swap del workspace (misma lógica que el cockpit original): cámara ↔ mapa.
  const [cameraPrimary, setCameraPrimary] = useState(false);
  // Intro A-EYE: se muestra al cargar y, al terminar la animacion del ojo, revela el cockpit.
  const [showIntro, setShowIntro] = useState(true);

  const handleMapClick = (point: LatLng): void => {
    if (mapMode === 'goal') {
      robot.dispatchGoal(point);
      setMapMode('idle');
    } else if (mapMode === 'addWaypoint') {
      robot.addWaypoint(point);
    }
  };

  const toggleSwap = (): void => setCameraPrimary((v) => !v);

  // Tecla "e" para alternar, igual que el cockpit.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (event.key.toLowerCase() === 'e') {
        toggleSwap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mapView = <MapView robot={robot} mapMode={mapMode} onMapClick={handleMapClick} variant={cameraPrimary ? 'mini' : 'full'} onSwap={toggleSwap} />;
  const cameraSmall = (
    <CameraPanel
      variant="panel"
      frameUrl={robot.cameraFrameUrl}
      cameraConnected={robot.cameraConnected}
      detections={robot.detections}
      detectionsActive={robot.detectionsActive}
      onSwap={toggleSwap}
    />
  );
  const cameraStage = (
    <CameraPanel
      variant="stage"
      frameUrl={robot.cameraFrameUrl}
      cameraConnected={robot.cameraConnected}
      detections={robot.detections}
      detectionsActive={robot.detectionsActive}
      onSwap={toggleSwap}
    />
  );

  return (
    <div className="aeye-shell h-screen overflow-hidden bg-surface-base p-1.5 text-ink">
      {showIntro ? <IntroAnimation onDone={() => setShowIntro(false)} /> : null}
      <div className="cockpit-frame relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <TopBar robot={robot} />

        <main className="workspace-frame flex min-h-0 flex-1 gap-2 overflow-y-auto p-2 lg:overflow-hidden">
          <IconRail />
          <NavPanel robot={robot} mapMode={mapMode} onSetMapMode={setMapMode} />

          {/* Área principal (grande): mapa o cámara según el swap */}
          {cameraPrimary ? cameraStage : mapView}

          <aside
            className={`right-stack flex w-full shrink-0 flex-col gap-2 lg:min-h-0 lg:overflow-y-auto lg:pr-0.5 ${
              cameraPrimary ? 'lg:w-[300px] xl:w-[330px]' : 'lg:w-[280px] xl:w-[300px] 2xl:w-[320px]'
            }`}
          >
            {/* Slot secundario (chico): el otro de los dos */}
            {cameraPrimary ? mapView : cameraSmall}
            <MissionStatus mission={robot.mission} />
            {cameraPrimary ? (
              <>
                <DetectionsPanel detections={robot.detections} detectionsActive={robot.detectionsActive} cameraConnected={robot.cameraConnected} />
                <section className="panel shrink-0 overflow-hidden">
                  <CameraPTZ disabled={!robot.backendConnected} onPan={robot.panCamera} onZoomToggle={robot.toggleCameraZoom} />
                </section>
              </>
            ) : null}
            <TelemetryPanel robot={robot} />
          </aside>
        </main>

        <StatusBar robot={robot} />
      </div>
    </div>
  );
}
