import { ConsoleTabRegistry } from "./consoleTabRegistry";
import { DispatcherRegistry } from "./dispatcherRegistry";
import { FooterItemRegistry } from "./footerItemRegistry";
import { ModalRegistry } from "./modalRegistry";
import { ServiceRegistry } from "./serviceRegistry";
import { SidebarPanelRegistry } from "./sidebarPanelRegistry";
import { ToolbarMenuRegistry } from "./toolbarMenuRegistry";
import { TransportRegistry } from "./transportRegistry";
import { WorkspaceViewRegistry } from "./workspaceViewRegistry";
import type { RegistryBundle } from "../types/module";

export function createRegistries(): RegistryBundle {
  return {
    toolbarMenuRegistry: new ToolbarMenuRegistry(),
    sidebarPanelRegistry: new SidebarPanelRegistry(),
    workspaceViewRegistry: new WorkspaceViewRegistry(),
    consoleTabRegistry: new ConsoleTabRegistry(),
    footerItemRegistry: new FooterItemRegistry(),
    modalRegistry: new ModalRegistry(),
    serviceRegistry: new ServiceRegistry(),
    dispatcherRegistry: new DispatcherRegistry(),
    transportRegistry: new TransportRegistry()
  };
}
