import { Router } from 'express';
import { authRequired } from '../middlewares/authJwt.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import * as colleges from '../models/bm.colleges.model.js';

const router = Router();
router.use('/bm/colleges', authRequired);
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const body = (req, key) => req.body?.[key] ?? req.body ?? {};
const validName = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const validEmail = (value) => value == null || value === '' || (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
const validOptionalText = (value, max) => value == null || (typeof value === 'string' && value.trim().length <= max);
const siteDetailKeys = ['email', 'address', 'tel', 'cel', 'city', 'category'];
const validSite = (value) => validName(value.city, 120)
  && validOptionalText(value.address, 500)
  && validOptionalText(value.category, 120)
  && validOptionalText(value.phone, 80)
  && validOptionalText(value.mobile, 80)
  && validEmail(value.email)
  && (value.is_primary === undefined || typeof value.is_primary === 'boolean');
const bad = (res, message) => res.status(400).json({ error: message });
const notFound = (res) => res.status(404).json({ error: 'College not found' });

router.get('/bm/colleges', asyncHandler(async (req, res) => {
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 20));
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const status = req.query.status;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'name';
  const direction = typeof req.query.direction === 'string' ? req.query.direction : 'asc';
  if (status && !['active', 'archived'].includes(status)) return bad(res, 'Invalid status');
  if (!['name', 'email', 'mobile', 'status'].includes(sort)) return bad(res, 'Invalid sort');
  if (!['asc', 'desc'].includes(direction)) return bad(res, 'Invalid direction');
  res.json(await colleges.list(req.user.companyId, { q, status, page, limit, sort, direction }));
}));

router.post('/bm/colleges', asyncHandler(async (req, res) => {
  const value = body(req, 'college');
  if (!validName(value.college_name, 200)) return bad(res, 'college_name is required (max 200 characters)');
  if (siteDetailKeys.some((key) => value[key] !== undefined)) return bad(res, 'Add address and contact details in the Sites tab after saving the college');
  res.status(201).json({ college: await colleges.create(req.user.companyId, { ...value, college_name: value.college_name.trim() }) });
}));

router.get('/bm/colleges/:collegeId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const college = await colleges.get(req.user.companyId, req.params.collegeId);
  return college ? res.json({ college }) : notFound(res);
}));

router.put('/bm/colleges/:collegeId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const value = body(req, 'college');
  if (siteDetailKeys.some((key) => value[key] !== undefined)) return bad(res, 'Edit address and contact details in the Sites tab');
  if (value.college_name !== undefined && !validName(value.college_name, 200)) return bad(res, 'Invalid college_name');
  if (value.status !== undefined && !['active', 'archived'].includes(value.status)) return bad(res, 'Invalid status');
  const college = await colleges.update(req.user.companyId, req.params.collegeId, value);
  return college ? res.json({ college }) : notFound(res);
}));

router.delete('/bm/colleges/:collegeId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const college = await colleges.update(req.user.companyId, req.params.collegeId, { status: 'archived' });
  return college ? res.status(204).send() : notFound(res);
}));

router.get('/bm/colleges/:collegeId/contacts', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const contacts = await colleges.contacts(req.user.companyId, req.params.collegeId);
  return contacts ? res.json({ contacts }) : notFound(res);
}));

router.post('/bm/colleges/:collegeId/contacts', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const value = body(req, 'contact');
  if (!validName(value.name, 120)) return bad(res, 'Contact name is required (max 120 characters)');
  if (!validEmail(value.email)) return bad(res, 'Invalid email');
  const contact = await colleges.createContact(req.user.companyId, req.params.collegeId, { ...value, name: value.name.trim() });
  return contact ? res.status(201).json({ contact }) : notFound(res);
}));

router.put('/bm/colleges/:collegeId/contacts/:contactId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId) || !uuid(req.params.contactId)) return bad(res, 'Invalid ID');
  const value = body(req, 'contact');
  if (value.name !== undefined && !validName(value.name, 120)) return bad(res, 'Invalid contact name');
  if (!validEmail(value.email)) return bad(res, 'Invalid email');
  const contact = await colleges.updateContact(req.user.companyId, req.params.collegeId, req.params.contactId, value);
  return contact ? res.json({ contact }) : res.status(404).json({ error: 'Contact not found' });
}));

router.delete('/bm/colleges/:collegeId/contacts/:contactId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId) || !uuid(req.params.contactId)) return bad(res, 'Invalid ID');
  const deleted = await colleges.deleteContact(req.user.companyId, req.params.collegeId, req.params.contactId);
  return deleted ? res.status(204).send() : res.status(404).json({ error: 'Contact not found' });
}));

router.get('/bm/colleges/:collegeId/sites', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const sites = await colleges.sites(req.user.companyId, req.params.collegeId);
  return sites ? res.json({ sites }) : notFound(res);
}));

router.post('/bm/colleges/:collegeId/sites', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId)) return bad(res, 'Invalid college ID');
  const value = body(req, 'site');
  if (!validSite(value)) return bad(res, 'Enter a city and valid site details');
  const site = await colleges.createSite(req.user.companyId, req.params.collegeId, { ...value, city: value.city.trim() });
  return site ? res.status(201).json({ site }) : notFound(res);
}));

router.put('/bm/colleges/:collegeId/sites/:siteId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId) || !uuid(req.params.siteId)) return bad(res, 'Invalid ID');
  const value = body(req, 'site');
  if (!validSite(value)) return bad(res, 'Enter a city and valid site details');
  try {
    const site = await colleges.updateSite(req.user.companyId, req.params.collegeId, req.params.siteId, { ...value, city: value.city.trim() });
    return site ? res.json({ site }) : res.status(404).json({ error: 'Site not found' });
  } catch (error) {
    if (error.code === 'PRIMARY_SITE_REQUIRED') return bad(res, error.message);
    throw error;
  }
}));

router.delete('/bm/colleges/:collegeId/sites/:siteId', asyncHandler(async (req, res) => {
  if (!uuid(req.params.collegeId) || !uuid(req.params.siteId)) return bad(res, 'Invalid ID');
  const deleted = await colleges.deleteSite(req.user.companyId, req.params.collegeId, req.params.siteId);
  return deleted ? res.status(204).send() : res.status(404).json({ error: 'Site not found' });
}));

export default router;
