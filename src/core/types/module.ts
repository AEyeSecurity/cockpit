import type { DispatchRouter } from "../../dispatcher/DispatchRouter";
import type { TransportManager } from "../../transport/manager/TransportManager";
import type { EnvConfig } from "../config/envConfig";
import type { ModuleConfig } from "../config/moduleConfigLoader";
import type { Container } from "../di/container";
import type { EventBus } from "../events/eventBus";
import type { ReactNode } from "react";
import type { ConsoleTabDefinition, FooterItemDefinition, ModalDialogDefinition, SidebarPanelDefinition, ToolbarMenuDefinition, WorkspaceViewDefinition } from "./ui";
import type { DispatcherDefinition } from "../registries/dispatcherRegistry";
import type { ServiceDefinition } from "../registries/serviceRegistry";
import type { TransportDefinition } from "../registries/transportRegistry";

export interface ToolbarMenuRegistryLike {
  registerToolbarMenu(definition: ToolbarMenuDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): ToolbarMenuDefinition | undefined;
  list(): ToolbarMenuDefinition[];
}

export interface SidebarPanelRegistryLike {
  registerSidebarPanel(definition: SidebarPanelDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): SidebarPanelDefinition | undefined;
  list(): SidebarPanelDefinition[];
}

export interface WorkspaceViewRegistryLike {
  registerWorkspaceView(definition: WorkspaceViewDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): WorkspaceViewDefinition | undefined;
  list(): WorkspaceViewDefinition[];
}

export interface ConsoleTabRegistryLike {
  registerConsoleTab(definition: ConsoleTabDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): ConsoleTabDefinition | undefined;
  list(): ConsoleTabDefinition[];
}

export interface FooterItemRegistryLike {
  registerFooterItem(definition: FooterItemDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): FooterItemDefinition | undefined;
  list(): FooterItemDefinition[];
}

export interface ModalRegistryLike {
  registerModalDialog(definition: ModalDialogDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): ModalDialogDefinition | undefined;
  list(): ModalDialogDefinition[];
}

export interface ServiceRegistryLike {
  registerService<T>(definition: ServiceDefinition<T>): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): ServiceDefinition | undefined;
  list(): ServiceDefinition[];
  getService<T>(id: string): T;
}

export interface DispatcherRegistryLike {
  registerDispatcher(definition: DispatcherDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): DispatcherDefinition | undefined;
  list(): DispatcherDefinition[];
}

export interface TransportRegistryLike {
  registerTransport(definition: TransportDefinition): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): TransportDefinition | undefined;
  list(): TransportDefinition[];
}

export interface RegistryBundle {
  toolbarMenuRegistry: ToolbarMenuRegistryLike;
  sidebarPanelRegistry: SidebarPanelRegistryLike;
  workspaceViewRegistry: WorkspaceViewRegistryLike;
  consoleTabRegistry: ConsoleTabRegistryLike;
  footerItemRegistry: FooterItemRegistryLike;
  modalRegistry: ModalRegistryLike;
  serviceRegistry: ServiceRegistryLike;
  dispatcherRegistry: DispatcherRegistryLike;
  transportRegistry: TransportRegistryLike;
}

export interface ModuleContext {
  packageId: string;
  env: EnvConfig;
  moduleConfig: ModuleConfig;
  container: Container;
  eventBus: EventBus;
  router: DispatchRouter;
  transportManager: TransportManager;
  registries: RegistryBundle;
  packages: LoadedPackage[];
  getService<T>(serviceId: string): T;
  getPackageConfig<T extends Record<string, unknown>>(packageId: string): T;
}

export interface AppRuntime extends ModuleContext {}

export interface CockpitModule {
  id: string;
  version: string;
  enabledByDefault: boolean;
  register(ctx: ModuleContext): void | Promise<void>;
}

export interface PackageSettingsSectionContext {
  runtime: AppRuntime;
  packageId: string;
  config: Record<string, unknown>;
}

export interface CockpitPackage {
  id: string;
  version: string;
  enabledByDefault: boolean;
  modules: CockpitModule[];
  createSettingsSection?: (ctx: PackageSettingsSectionContext) => ReactNode;
}

export interface PackageCatalogEntry {
  path: string;
  cockpitPackage: CockpitPackage;
  config: Record<string, unknown>;
}

export interface LoadedPackage {
  id: string;
  version: string;
  enabled: boolean;
  moduleIds: string[];
  createSettingsSection?: CockpitPackage["createSettingsSection"];
}
