import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  getTeams,
  insertTeam,
  updateTeamById,
  deleteTeamById,
  setTeamsOrder,
  getNextTeamOrder,
  getMembersByTeam,
  replaceMembers,
} from "../models/team.model.js";

const toDTO = (row) => ({
  id: row.id,
  name: row.name,
  displayOrder: Number(row.display_order) || 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listTeams = asyncHandler(async (_req, res) => {
  const rows = await getTeams();
  res.json({ teams: rows.map(toDTO) });
});

export const createTeam = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name)
    return res.status(422).json({ errors: { name: ["can't be blank"] } });
  const order = await getNextTeamOrder();
  const row = await insertTeam({ name, displayOrder: order });
  res.status(201).json({ team: toDTO(row) });
});

export const updateTeam = asyncHandler(async (req, res) => {
  const row = await updateTeamById(req.params.id, { name: req.body?.name });
  if (!row) return res.status(404).json({ error: "Team not found" });
  res.json({ team: toDTO(row) });
});

export const deleteTeam = asyncHandler(async (req, res) => {
  const ok = await deleteTeamById(req.params.id);
  if (!ok) return res.status(404).json({ error: "Team not found" });
  res.status(204).end();
});

export const reorderTeams = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(422).json({ error: "ids is required" });
  await setTeamsOrder(ids);
  const rows = await getTeams();
  res.json({ teams: rows.map(toDTO) });
});

/** MEMBERS */
export const getTeamMembers = asyncHandler(async (req, res) => {
  const members = await getMembersByTeam(req.params.id);
  res.json({ members });
});

export const setTeamMembers = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds : [];
  await replaceMembers(req.params.id, ids);
  const members = await getMembersByTeam(req.params.id);
  res.json({ members });
});
