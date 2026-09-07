import "dotenv/config";
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
  ["10000000-0000-4000-8000-000000000011", "rent", "Apartment", "City-edge apartment with balcony", "406/18 McDougall Street", "Milton", "4064", -27.4701, 153.0032, "$640 per week", 640, 2, 2, 1, "A well-connected apartment near cafes, rail and the river with a private balcony and secure parking.", ["Balcony", "Air conditioning", "Secure parking"]],
  ["10000000-0000-4000-8000-000000000012", "sale", "House", "Classic home in a leafy pocket", "42 Fernberg Road", "Paddington", "4064", -27.4591, 152.9988, "Offers over $1,350,000", 1350000, 4, 2, 2, "A character-filled home with updated interiors, flexible living spaces and a landscaped rear garden.", ["Timber floors", "Rear deck", "Landscaped garden"]],
  ["10000000-0000-4000-8000-000000000013", "rent", "Unit", "Convenient Toowong residence", "9/56 Sherwood Road", "Toowong", "4066", -27.4852, 152.9921, "$575 per week", 575, 2, 1, 1, "A practical two-bedroom residence close to Toowong Village, university connections and public transport.", ["Built-in wardrobes", "Balcony", "Lock-up garage"]],
  ["10000000-0000-4000-8000-000000000014", "sale", "Apartment", "Contemporary inner-south apartment", "705/22 Deshon Street", "Woolloongabba", "4102", -27.4967, 153.0381, "$735,000", 735000, 2, 2, 1, "A contemporary apartment with open-plan living and easy access to the Gabba and upcoming transport links.", ["City outlook", "Resident pool", "Secure entry"]],
  ["10000000-0000-4000-8000-000000000015", "rent", "Apartment", "Valley apartment near entertainment precinct", "812/38 Warner Street", "Fortitude Valley", "4006", -27.4575, 153.0354, "$610 per week", 610, 1, 1, 1, "A central apartment offering low-maintenance living near dining, entertainment and rail services.", ["Rooftop terrace", "Gym", "Secure parking"]],
  ["10000000-0000-4000-8000-000000000016", "sale", "Unit", "South Brisbane lifestyle address", "14/67 Cordelia Street", "South Brisbane", "4101", -27.4754, 153.0182, "Offers over $685,000", 685000, 2, 1, 1, "A bright unit within walking distance of South Bank, cultural venues and public transport.", ["Balcony", "Pool", "Storage cage"]],
  ["10000000-0000-4000-8000-000000000017", "rent", "Apartment", "Teneriffe warehouse-style apartment", "203/12 Commercial Road", "Teneriffe", "4005", -27.4556, 153.0472, "$780 per week", 780, 2, 2, 1, "A spacious warehouse-style apartment near the riverwalk with high ceilings and generous living areas.", ["High ceilings", "Riverwalk access", "Air conditioning"]],
  ["10000000-0000-4000-8000-000000000018", "sale", "House", "Family living near parklands", "28 Scrub Road", "Carindale", "4152", -27.5028, 153.1015, "$1,180,000", 1180000, 4, 2, 2, "A comfortable family home with multiple living zones and convenient access to shopping and parklands.", ["Covered entertaining area", "Double garage", "Fenced yard"]],
  ["10000000-0000-4000-8000-000000000019", "rent", "Townhouse", "Spacious townhouse near major amenities", "6/91 Hamilton Road", "Chermside", "4032", -27.3854, 153.0301, "$660 per week", 660, 3, 2, 2, "A modern townhouse with private outdoor space close to shopping, hospitals and transport.", ["Courtyard", "Double garage", "Air conditioning"]],
  ["10000000-0000-4000-8000-000000000020", "sale", "Apartment", "Indooroopilly apartment with district views", "1103/8 Station Road", "Indooroopilly", "4068", -27.4998, 152.9731, "$790,000", 790000, 3, 2, 2, "A generous apartment with district views and convenient access to shopping, rail and local schools.", ["Large balcony", "Two car spaces", "Resident lounge"]],
  ["10000000-0000-4000-8000-000000000021", "rent", "House", "Comfortable home with flexible study", "16 Grenfell Street", "Mount Gravatt East", "4122", -27.5398, 153.0798, "$720 per week", 720, 3, 2, 2, "A comfortable home with a separate study, covered patio and straightforward access to local schools.", ["Study", "Covered patio", "Fenced garden"]],
  ["10000000-0000-4000-8000-000000000022", "sale", "Townhouse", "Stylish Coorparoo townhouse", "2/35 Harries Road", "Coorparoo", "4151", -27.4931, 153.0592, "Offers over $925,000", 925000, 3, 2, 2, "A stylish townhouse with well-zoned living, quality finishes and a private landscaped courtyard.", ["Ducted air conditioning", "Courtyard", "Double garage"]],
  ["10000000-0000-4000-8000-000000000023", "rent", "Apartment", "Hamilton riverside apartment", "909/33 Harbour Road", "Hamilton", "4007", -27.4393, 153.0661, "$750 per week", 750, 2, 2, 1, "A riverside apartment with a generous balcony and easy access to dining, ferry and recreation facilities.", ["River views", "Pool", "Gym"]],
  ["10000000-0000-4000-8000-000000000024", "sale", "Unit", "Renovated Auchenflower unit", "4/19 Dunmore Terrace", "Auchenflower", "4066", -27.4751, 152.9935, "$615,000", 615000, 2, 1, 1, "A renovated unit in a small complex near the river, transport and the Wesley Hospital.", ["Renovated bathroom", "Balcony", "Garage"]],
  ["10000000-0000-4000-8000-000000000025", "rent", "House", "Everton Park family home", "73 Trouts Road", "Everton Park", "4053", -27.4072, 152.9913, "$760 per week", 760, 4, 2, 2, "A practical family home with open living, a secure yard and convenient access to shops and schools.", ["Fenced yard", "Air conditioning", "Double carport"]],
  ["10000000-0000-4000-8000-000000000026", "sale", "Apartment", "Greenslopes apartment with city outlook", "602/11 Chatsworth Road", "Greenslopes", "4120", -27.5082, 153.0491, "$710,000", 710000, 2, 2, 1, "A modern apartment with a city outlook near hospitals, cafes and frequent bus services.", ["City outlook", "Secure entry", "Balcony"]],
  ["10000000-0000-4000-8000-000000000027", "rent", "Townhouse", "Quiet Norman Park townhouse", "3/84 Bennetts Road", "Norman Park", "4170", -27.4797, 153.0644, "$695 per week", 695, 3, 2, 1, "A quiet townhouse with a private courtyard and convenient access to rail and local village amenities.", ["Courtyard", "Study nook", "Remote garage"]],
  ["10000000-0000-4000-8000-000000000028", "sale", "House", "Bayside home with entertaining deck", "51 Bay Terrace", "Wynnum", "4178", -27.4457, 153.1712, "Offers over $1,050,000", 1050000, 4, 2, 2, "A welcoming bayside home with an entertaining deck, flexible family areas and access to the waterfront.", ["Entertaining deck", "Solar power", "Bayside location"]],
  ["10000000-0000-4000-8000-000000000029", "rent", "Unit", "Clayfield unit close to rail", "7/30 Sandgate Road", "Clayfield", "4011", -27.4182, 153.0587, "$530 per week", 530, 2, 1, 1, "A tidy unit in a convenient position near rail, local shops and airport connections.", ["Balcony", "Garage", "Ceiling fans"]],
  ["10000000-0000-4000-8000-000000000030", "sale", "House", "Updated Stafford family residence", "24 Webster Road", "Stafford", "4053", -27.4107, 153.0114, "$1,090,000", 1090000, 4, 2, 2, "An updated family residence with open living, a level garden and excellent access to northern suburbs amenities.", ["Level garden", "Media room", "Double garage"]],
  ["10000000-0000-4000-8000-000000000031", "rent", "House", "Modern Rochedale family home", "12 Splendour Street", "Rochedale", "4123", -27.5701, 153.1237, "$890 per week", 890, 4, 2, 2, "A modern family home with spacious interiors, a covered patio and convenient motorway access.", ["Ducted air conditioning", "Covered patio", "Walk-in pantry"]],
  ["10000000-0000-4000-8000-000000000032", "sale", "Apartment", "New Farm apartment near the river", "5/96 Sydney Street", "New Farm", "4005", -27.4682, 153.0452, "$820,000", 820000, 2, 2, 1, "A light-filled apartment near the riverwalk, New Farm Park and the suburb's dining precinct.", ["Riverwalk nearby", "Balcony", "Secure parking"]],
  ["10000000-0000-4000-8000-000000000033", "rent", "Apartment", "Chermside two-bedroom apartment", "408/15 Playfield Street", "Chermside", "4032", -27.3842, 153.0326, "$590 per week", 590, 2, 2, 1, "A low-maintenance apartment close to major shopping, medical facilities and public transport.", ["Pool", "Lift access", "Air conditioning"]],
  ["10000000-0000-4000-8000-000000000034", "sale", "Townhouse", "Morningside courtyard townhouse", "8/101 Richmond Road", "Morningside", "4170", -27.4678, 153.0717, "Offers over $890,000", 890000, 3, 2, 2, "A contemporary townhouse with a private courtyard and easy access to rail, cafes and local schools.", ["Private courtyard", "Double garage", "Storage"]],
  ["10000000-0000-4000-8000-000000000035", "rent", "Unit", "Affordable Nundah unit", "11/48 Buckland Road", "Nundah", "4012", -27.4019, 153.0598, "$495 per week", 495, 2, 1, 1, "A neat unit offering straightforward access to Nundah Village, rail and airport employment areas.", ["Balcony", "Garage", "Built-in wardrobes"]],
  ["10000000-0000-4000-8000-000000000036", "sale", "House", "Elevated Bulimba family home", "67 Oxford Street", "Bulimba", "4171", -27.4521, 153.0626, "$1,620,000", 1620000, 4, 3, 2, "An elevated family home with generous entertaining spaces near Oxford Street and the river.", ["Entertaining terrace", "Pool", "Home office"]],
  ["10000000-0000-4000-8000-000000000037", "rent", "Townhouse", "Kelvin Grove modern townhouse", "4/27 Herston Road", "Kelvin Grove", "4059", -27.4502, 153.0146, "$710 per week", 710, 3, 2, 1, "A modern townhouse near the university precinct with flexible living and a private outdoor area.", ["Courtyard", "Air conditioning", "Study area"]],
  ["10000000-0000-4000-8000-000000000038", "sale", "Apartment", "Newstead premium apartment", "1506/70 Longland Street", "Newstead", "4006", -27.4497, 153.0438, "$1,080,000", 1080000, 3, 2, 2, "A premium apartment with expansive living, refined finishes and convenient access to Gasworks and the river.", ["Resident pool", "Two car spaces", "City views"]],
  ["10000000-0000-4000-8000-000000000039", "rent", "House", "Camp Hill home with pool", "29 Martha Street", "Camp Hill", "4152", -27.4925, 153.0753, "$980 per week", 980, 4, 3, 2, "A spacious family home with multiple living areas, a pool and a covered outdoor entertaining zone.", ["Pool", "Multiple living areas", "Covered deck"]],
  ["10000000-0000-4000-8000-000000000040", "sale", "Unit", "West End riverside unit", "12/21 Riverside Drive", "West End", "4101", -27.4811, 153.0069, "$650,000", 650000, 2, 1, 1, "A well-positioned unit near riverside paths, markets, dining and frequent transport services.", ["River access", "Balcony", "Secure garage"]],
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
  ["selling", "Does Queensland require seller disclosure?", "Queensland has a statutory seller disclosure scheme. The agency can explain the documents required for the sales campaign, and the seller's conveyancer or solicitor can prepare and review them before the buyer signs the contract.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home"],
  ["selling", "How is a real-estate agent appointed?", "A Queensland property owner appoints an agent in writing using the prescribed appointment process. The appointment records the services, term, fees, commission and authorised expenses.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home/using-an-agent"],
  ["selling", "How are agent commission and marketing costs agreed?", "Commission, fees and marketing expenses should be agreed with the agent and recorded in the written appointment before the campaign begins.", "https://www.qld.gov.au/law/housing-and-neighbours/buying-and-selling-a-property/selling-a-home/using-an-agent"],
  ["inspections", "How do I book an inspection?", "Choose an available property and inspection time, then provide your name and email. Sophia will repeat the property and time for confirmation before creating the booking."],
];

function inspectionSlotId(propertyIndex, slotIndex) {
  return `20000000-0000-4000-8000-${String((propertyIndex + 1) * 10 + slotIndex + 1).padStart(12, "0")}`;
}

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

    await client.query(`DELETE FROM bm_property_inspection_slots s
      WHERE s.property_id = $1 AND s.starts_at > now()
        AND NOT EXISTS (
          SELECT 1 FROM bm_property_inspection_bookings b WHERE b.slot_id = s.slot_id
        )`, [propertyId]);
    for (const [slotIndex, dayOffset] of [2, 4, 6].entries()) {
      const startsAt = new Date();
      startsAt.setDate(startsAt.getDate() + dayOffset + (index % 2));
      startsAt.setHours(index % 2 ? 14 : 10, 30, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
      await client.query(`INSERT INTO bm_property_inspection_slots
        (slot_id, property_id, starts_at, ends_at, capacity)
        VALUES ($1,$2,$3,$4,10)
        ON CONFLICT (slot_id) DO UPDATE SET
          property_id=EXCLUDED.property_id, starts_at=EXCLUDED.starts_at,
          ends_at=EXCLUDED.ends_at, capacity=EXCLUDED.capacity, status='open'`,
        [inspectionSlotId(index, slotIndex), propertyId, startsAt, endsAt]);
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
