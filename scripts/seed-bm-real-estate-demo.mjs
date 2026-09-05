import "dotenv/config";
import { randomUUID } from "node:crypto";
import pool from "../src/config/db.js";

const companyId = process.env.BM_DEMO_COMPANY_ID;
if (!companyId) throw new Error("BM_DEMO_COMPANY_ID is required.");

const properties = [
  ["10000000-0000-4000-8000-000000000001", "rent", "House", "Family home near the river", "18 Jacaranda Street", "Bulimba", "4171", -27.4512, 153.0618, "$820 per week", 820, 4, 2, 2, "A bright family home with open-plan living, a covered entertaining area and easy access to local shops and the riverwalk.", ["Air conditioning", "Covered patio", "Fenced garden"]],
  ["10000000-0000-4000-8000-000000000002", "rent", "Apartment", "Modern apartment with city views", "1204/25 River Terrace", "Kangaroo Point", "4169", -27.4768, 153.0358, "$690 per week", 690, 2, 2, 1, "A modern two-bedroom apartment with a balcony, city outlook and resident facilities close to the CBD ferry.", ["Balcony", "Pool", "Secure parking"]],
  ["10000000-0000-4000-8000-000000000003", "rent", "Townhouse", "Low-maintenance townhouse", "7/42 Hawthorne Road", "Hawthorne", "4171", -27.4612, 153.0588, "$740 per week", 740, 3, 2, 2, "A quiet townhouse with generous living areas, private courtyard and convenient access to schools and transport.", ["Courtyard", "Study nook", "Double garage"]],
  ["10000000-0000-4000-8000-000000000004", "rent", "Unit", "Renovated unit close to transport", "5/76 Junction Road", "Morningside", "4170", -27.4687, 153.0738, "$560 per week", 560, 2, 1, 1, "A renovated unit with a practical floor plan and quick connections to Morningside train station and local cafes.", ["Renovated kitchen", "Built-in wardrobes", "Balcony"]],
  ["10000000-0000-4000-8000-000000000005", "rent", "Apartment", "Riverside one-bedroom apartment", "308/9 Duncan Street", "West End", "4101", -27.4798, 153.0078, "$590 per week", 590, 1, 1, 1, "A well-presented riverside apartment with a study space and access to landscaped resident facilities.", ["Study", "Gym", "Pool"]],
  ["10000000-0000-4000-8000-000000000006", "sale", "House", "Character home with modern comfort", "31 Gresham Street", "Ashgrove", "4060", -27.4451, 152.9948, "Offers over $1,295,000", 1295000, 4, 2, 2, "A renovated character home combining traditional detail with modern living and a private rear garden.", ["Character features", "Solar power", "Rear deck"]],
  ["10000000-0000-4000-8000-000000000007", "sale", "Apartment", "Executive riverfront residence", "1702/88 Skyring Terrace", "Newstead", "4006", -27.4502, 153.0442, "$995,000", 995000, 2, 2, 1, "A refined riverfront apartment with an open living area, premium finishes and convenient access to Gasworks precinct.", ["River views", "Concierge", "Resident pool"]],
  ["10000000-0000-4000-8000-000000000008", "sale", "Townhouse", "Contemporary inner-city townhouse", "3/14 Victoria Street", "Kelvin Grove", "4059", -27.4494, 153.0138, "For sale $875,000", 875000, 3, 2, 1, "A contemporary townhouse offering flexible living, a private courtyard and a convenient inner-city position.", ["Courtyard", "Ducted air conditioning", "Storage"]],
  ["10000000-0000-4000-8000-000000000009", "sale", "House", "Elevated family retreat", "62 Clara Street", "Camp Hill", "4152", -27.4932, 153.0741, "Auction", 1450000, 5, 3, 2, "An elevated family residence with multiple living areas, a pool and an outlook across the eastern suburbs.", ["Pool", "Multiple living areas", "City glimpses"]],
  ["10000000-0000-4000-8000-000000000010", "sale", "Unit", "Entry-level investment opportunity", "8/24 York Street", "Nundah", "4012", -27.4028, 153.0615, "Offers over $535,000", 535000, 2, 1, 1, "A tidy two-bedroom unit in a small complex, positioned close to Nundah Village and rail services.", ["Secure garage", "Balcony", "Low-maintenance"]],
];

const photoUrls = [
  "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=85",
  "https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1400&q=85",
];

const knowledge = [
  ["renting", "What information can an agent request in a rental application?", "In Queensland, rental applicants generally use the standard application form and may be asked for identity, financial capacity and suitability information. The agent should only request information allowed by current tenancy rules.", "https://www.rta.qld.gov.au/before-renting/applying-for-a-rental-property"],
  ["renting", "What documents should I prepare to apply for a rental property in Brisbane?", "For a Brisbane rental application, be ready to complete Queensland's standard Rental Application Form 22. Prepare up to two identity documents, such as a driver licence, passport or birth certificate; up to two documents showing you can pay the rent, such as recent payslips, an employment contract, a Centrelink statement, or a bank balance statement without transaction details; and up to two documents showing suitability, such as rental references or rental history. Also have your contact details, current employment and income details, intended tenancy term, household occupants, vehicles and pets ready. The property's application instructions will confirm which permitted documents the agency requests.", "https://www.rta.qld.gov.au/before-renting/applying-for-a-rental-property/application-process"],
  ["renting", "How many supporting documents can a Queensland rental agent request?", "A Queensland property manager or owner can request no more than two documents in each category: identity, financial ability to pay rent, and suitability for the tenancy. An applicant may voluntarily provide more, but the agency must not request or encourage extra documents.", "https://www.rta.qld.gov.au/before-renting/applying-for-a-rental-property/application-process"],
  ["renting", "What financial documents can support a Brisbane rental application?", "Common evidence includes recent payslips, an employment contract, a Centrelink payment statement, proof of savings or assets, or a bank balance statement without transaction details. Self-employed, casual or freelance applicants can ask the agency which permitted alternatives suit their circumstances.", "https://www.rta.qld.gov.au/before-renting/applying-for-a-rental-property/application-process"],
  ["renting", "How much rental bond can be requested?", "Queensland bond limits and rules depend on the tenancy and weekly rent. Confirm the current amount with the agency and use the Residential Tenancies Authority process for lodging the bond.", "https://www.rta.qld.gov.au/starting-a-tenancy/rental-bond"],
  ["renting", "What happens at a rental property inspection?", "An inspection lets prospective tenants view the property and ask practical questions. Registration may be required, and attending an inspection does not guarantee approval of an application.", "https://www.rta.qld.gov.au/before-renting/choosing-a-rental-property"],
  ["selling", "What should an owner prepare before selling a property?", "An owner should speak with the appointed agent about the sales method, marketing, presentation, required disclosures, contract preparation and the proposed campaign timeline.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home"],
  ["selling", "Does Queensland require seller disclosure?", "Queensland has a statutory seller disclosure scheme. Sellers should obtain current legal advice and prepare the required disclosure documents before the buyer signs the contract.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home"],
  ["selling", "How is a real-estate agent appointed?", "A Queensland property owner appoints an agent in writing using the prescribed appointment process. The appointment records the services, term, fees, commission and authorised expenses.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home/using-an-agent"],
  ["selling", "How are agent commission and marketing costs agreed?", "Commission, fees and marketing expenses should be agreed with the agent and recorded in the written appointment before the campaign begins.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home/using-an-agent"],
  ["inspections", "How do I book an inspection?", "Choose an available property and inspection time, then provide your name and email. Sophia will repeat the property and time for confirmation before creating the booking."],
  ["general", "Is the information from Sophia legal or financial advice?", "No. Sophia provides agency-approved general information and can help with property searches and inspection bookings. Customers should obtain professional advice for legal, financial or contractual decisions."],
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const company = await client.query("SELECT company_id FROM bm_company WHERE company_id = $1", [companyId]);
  if (!company.rowCount) throw new Error(`Business Manager company not found: ${companyId}`);

  for (const [index, property] of properties.entries()) {
    const [propertyId, listingType, propertyType, title, address, suburb, postcode, latitude, longitude, priceDisplay, priceAmount, bedrooms, bathrooms, carSpaces, description, features] = property;
    await client.query(`INSERT INTO bm_properties (
      property_id, company_id, listing_type, property_type, title, address, suburb, city, postcode,
      latitude, longitude, price_display, price_amount, bedrooms, bathrooms, car_spaces,
      description, features, agent_name, agent_email, agent_phone
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Brisbane',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)
    ON CONFLICT (property_id) DO UPDATE SET
      company_id=EXCLUDED.company_id, listing_type=EXCLUDED.listing_type, property_type=EXCLUDED.property_type,
      title=EXCLUDED.title, address=EXCLUDED.address, suburb=EXCLUDED.suburb, city=EXCLUDED.city, postcode=EXCLUDED.postcode,
      latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, price_display=EXCLUDED.price_display,
      price_amount=EXCLUDED.price_amount, bedrooms=EXCLUDED.bedrooms, bathrooms=EXCLUDED.bathrooms,
      car_spaces=EXCLUDED.car_spaces, description=EXCLUDED.description, features=EXCLUDED.features,
      agent_name=EXCLUDED.agent_name, agent_email=EXCLUDED.agent_email, agent_phone=EXCLUDED.agent_phone,
      status='available', updatedat=now()`,
      [propertyId, companyId, listingType, propertyType, title, address, suburb, postcode, latitude, longitude, priceDisplay, priceAmount, bedrooms, bathrooms, carSpaces, description, JSON.stringify(features), "Alex Morgan", "alex.morgan@example.com", "07 3000 4100"]);

    await client.query("DELETE FROM bm_property_media WHERE property_id = $1", [propertyId]);
    for (let sortOrder = 0; sortOrder < 3; sortOrder += 1) {
      const url = photoUrls[(index + sortOrder) % photoUrls.length];
      await client.query("INSERT INTO bm_property_media (property_id, media_url, alt_text, sort_order) VALUES ($1,$2,$3,$4)", [propertyId, url, `${title} photo ${sortOrder + 1}`, sortOrder]);
    }

    await client.query(`DELETE FROM bm_property_inspection_bookings
      WHERE property_id = $1 AND slot_id IN (
        SELECT slot_id FROM bm_property_inspection_slots
        WHERE property_id = $1 AND starts_at > now()
      )`, [propertyId]);
    await client.query("DELETE FROM bm_property_inspection_slots WHERE property_id = $1 AND starts_at > now()", [propertyId]);
    for (const dayOffset of [2, 4, 6]) {
      const startsAt = new Date();
      startsAt.setDate(startsAt.getDate() + dayOffset + (index % 2));
      startsAt.setHours(index % 2 ? 14 : 10, 30, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
      await client.query("INSERT INTO bm_property_inspection_slots (slot_id, property_id, starts_at, ends_at, capacity) VALUES ($1,$2,$3,$4,10)", [randomUUID(), propertyId, startsAt, endsAt]);
    }
  }

  await client.query("DELETE FROM bm_agency_knowledge WHERE company_id = $1", [companyId]);
  for (const [category, question, answer, sourceUrl = null] of knowledge) {
    await client.query(`INSERT INTO bm_agency_knowledge
      (company_id, category, question, answer, source_url, jurisdiction, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,'Queensland, Australia',CURRENT_DATE)`,
      [companyId, category, question, answer, sourceUrl]);
  }

  await client.query("COMMIT");
  console.log(`Real-estate demo seeded: ${properties.length} properties, ${properties.length * 3} inspection slots, ${knowledge.length} knowledge entries.`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Real-estate demo seed failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
