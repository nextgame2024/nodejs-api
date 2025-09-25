import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getEmployees } from "../models/employee.model.js";

export const listEmployees = asyncHandler(async (_req, res) => {
  const rows = await getEmployees();
  res.json({ employees: rows });
});
