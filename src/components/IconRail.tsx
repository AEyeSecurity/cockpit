import { BarChart3, Camera, ChevronLeft, ClipboardList, Navigation, Settings } from 'lucide-react';

const items = [
  { icon: Navigation, label: 'Navegación' },
  { icon: BarChart3, label: 'Telemetría' },
  { icon: Camera, label: 'Cámara' },
  { icon: Settings, label: 'Ajustes' },
  { icon: ClipboardList, label: 'Misiones' },
];

export function IconRail() {
  return (
    <nav className="sel icon-rail hidden shrink-0 lg:flex">
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = index === 0;
        return (
          <button
            key={item.label}
            type="button"
            aria-label={item.label}
            title={item.label}
            className={`sel-btn ${active ? 'active' : ''}`}
          >
            <Icon size={18} />
          </button>
        );
      })}
      <div className="sel-spacer" />
      <div className="sel-div" />
      <button className="sel-btn sel-collapse" type="button" aria-label="Colapsar" title="Colapsar">
        <ChevronLeft size={16} />
      </button>
    </nav>
  );
}
