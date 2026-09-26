import type {
  AvailabilityOption,
  CapabilityContext,
  CatalogItem,
  CommandReceipt,
  ExtensionValue,
  KnowledgeRecord,
  MediaItem,
  OperationStatus,
  PageInfo,
  PageRequest,
  PreparedCommand,
  ResourceRef,
  SourceMetadata,
} from "../contracts/business-capability.contracts.js";

export type Paged<T> = { items: T[]; page: PageInfo; sources?: SourceMetadata[] };

export interface KnowledgePort {
  search(input: { query: string; page: PageRequest; extension?: ExtensionValue }, context: CapabilityContext): Promise<Paged<KnowledgeRecord>>;
}

export interface CatalogPort {
  search(input: { query?: string; page: PageRequest; extension?: ExtensionValue }, context: CapabilityContext): Promise<Paged<CatalogItem>>;
  get(input: { resource: ResourceRef; extension?: ExtensionValue }, context: CapabilityContext): Promise<{ item: CatalogItem; sources?: SourceMetadata[] }>;
  getMedia(input: { resource: ResourceRef; extension?: ExtensionValue }, context: CapabilityContext): Promise<{ items: MediaItem[]; sources?: SourceMetadata[] }>;
}

export interface AvailabilityPort {
  search(input: { resource: ResourceRef; from: string; to: string; extension?: ExtensionValue }, context: CapabilityContext): Promise<{ options: AvailabilityOption[]; sources?: SourceMetadata[] }>;
  revalidate(input: { resource: ResourceRef; optionRef: string; extension?: ExtensionValue }, context: CapabilityContext): Promise<{ option: AvailabilityOption; revalidatedAt: string }>;
}

export interface BookingPort {
  prepare(input: { resource: ResourceRef; optionRef: string; extension?: ExtensionValue }, context: CapabilityContext): Promise<PreparedCommand>;
  commit(input: { reviewId: string; commandId: string; extension: ExtensionValue }, context: CapabilityContext): Promise<CommandReceipt>;
  getStatus(input: { operationRef: string }, context: CapabilityContext): Promise<OperationStatus>;
  reconcile(input: { commandId: string }, context: CapabilityContext): Promise<OperationStatus>;
}

export interface DeliveryPort {
  getStatus(input: { operationRef: string }, context: CapabilityContext): Promise<OperationStatus>;
  prepareResend(input: { operationRef: string; extension?: ExtensionValue }, context: CapabilityContext): Promise<PreparedCommand>;
  commitResend(input: { reviewId: string; commandId: string; extension: ExtensionValue }, context: CapabilityContext): Promise<CommandReceipt>;
  reconcile(input: { commandId: string }, context: CapabilityContext): Promise<OperationStatus>;
}

export interface WorkflowStatusPort {
  getStatus(input: { workflowRef: string }, context: CapabilityContext): Promise<OperationStatus>;
}

export interface HandoffPort {
  request(input: { reason: string; extension?: ExtensionValue }, context: CapabilityContext): Promise<CommandReceipt>;
  getStatus(input: { operationRef: string }, context: CapabilityContext): Promise<OperationStatus>;
}

export interface PresentationPort {
  dismiss(input: { presentationRef?: string }, context: CapabilityContext): Promise<{ dismissed: true }>;
}
