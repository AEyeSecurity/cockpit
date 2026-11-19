import { Component, Suspense, type ReactNode } from "react";

export class DeferredView extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <p role="alert">No se pudo abrir esta vista. Recargá Cockpit para volver a intentarlo.</p>;
    }
    return (
      <Suspense fallback={<p role="status">Cargando vista…</p>}>
        {this.props.children}
      </Suspense>
    );
  }
}
