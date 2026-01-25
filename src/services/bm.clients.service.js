import * as model from "../models/bm.clients.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listClients(userId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [clients, total] = await Promise.all([
    model.listClients(userId, { q, status, limit: safeLimit, offset }),
    model.countClients(userId, { q, status }),
  ]);

  return { clients, page: safePage, limit: safeLimit, total };
}

export function getClient(userId, clientId) {
  return model.getClient(userId, clientId);
}

export function createClient(userId, payload) {
  return model.createClient(userId, payload);
}

export function updateClient(userId, clientId, payload) {
  return model.updateClient(userId, clientId, payload);
}

export function archiveClient(userId, clientId) {
  return model.archiveClient(userId, clientId);
}

// Contacts: return null when client does not exist for this user
export async function listClientContacts(userId, clientId) {
  const exists = await model.clientExists(userId, clientId);
  if (!exists) return null;
  return model.listClientContacts(userId, clientId);
}

export async function createClientContact(userId, clientId, payload) {
  const exists = await model.clientExists(userId, clientId);
  if (!exists) return null;
  return model.createClientContact(userId, clientId, payload);
}

export function updateClientContact(userId, clientId, contactId, payload) {
  return model.updateClientContact(userId, clientId, contactId, payload);
}

export function deleteClientContact(userId, clientId, contactId) {
  return model.deleteClientContact(userId, clientId, contactId);
}
