export const companyId = "10000000-0000-4000-8000-000000000001";

export const rentalProperty = Object.freeze({
  propertyId: "20000000-0000-4000-8000-000000000001",
  companyId,
  listingType: "rent",
  propertyType: "unit",
  status: "available",
  title: "Two-bedroom rental",
  address: "11/48 Buckland Road",
  suburb: "Nundah",
  city: "Brisbane",
  state: "QLD",
  postcode: "4012",
  priceDisplay: "$620 per week",
  bedrooms: 2,
  bathrooms: 1,
  carSpaces: 1,
  description: "Authoritative rental description",
  features: ["balcony"],
  media: [
    {
      mediaId: "21000000-0000-4000-8000-000000000001",
      url: "https://fixtures.invalid/rental-1.jpg",
      altText: "Rental living room",
      sortOrder: 1,
    },
  ],
});

export const saleProperty = Object.freeze({
  propertyId: "20000000-0000-4000-8000-000000000002",
  companyId,
  listingType: "sale",
  propertyType: "house",
  status: "available",
  title: "Four-bedroom home",
  address: "51 Bay Terrace",
  suburb: "Wynnum",
  city: "Brisbane",
  state: "QLD",
  postcode: "4178",
  priceDisplay: "Offers over $1,050,000",
  bedrooms: 4,
  bathrooms: 2,
  carSpaces: 2,
  description: "Authoritative sale description",
  features: ["study", "deck"],
  media: [
    {
      mediaId: "21000000-0000-4000-8000-000000000002",
      url: "https://fixtures.invalid/sale-1.jpg",
      altText: "Sale property exterior",
      sortOrder: 1,
    },
  ],
});

export const propertyWithMissingOptionalFields = Object.freeze({
  ...rentalProperty,
  propertyId: "20000000-0000-4000-8000-000000000003",
  title: "Property with unavailable optional details",
  description: null,
  features: [],
  agentPhone: null,
  media: [],
});

export const capacityOneSlot = Object.freeze({
  slotId: "22000000-0000-4000-8000-000000000001",
  propertyId: rentalProperty.propertyId,
  startsAt: "2026-10-01T00:30:00.000Z",
  endsAt: "2026-10-01T01:00:00.000Z",
  capacity: 1,
  placesAvailable: 1,
});

export const multiCapacitySlot = Object.freeze({
  slotId: "22000000-0000-4000-8000-000000000002",
  propertyId: saleProperty.propertyId,
  startsAt: "2026-10-03T04:30:00.000Z",
  endsAt: "2026-10-03T05:00:00.000Z",
  capacity: 4,
  placesAvailable: 2,
});

export const rentalBooking = Object.freeze({
  bookingId: "23000000-0000-4000-8000-000000000001",
  companyId,
  propertyId: rentalProperty.propertyId,
  slotId: capacityOneSlot.slotId,
  listingType: "rent",
  customerName: "Demo Customer",
  customerEmail: "demo.customer@example.com",
  status: "confirmed",
  startsAt: capacityOneSlot.startsAt,
});

export const saleBookingWaitingForReport = Object.freeze({
  bookingId: "23000000-0000-4000-8000-000000000002",
  companyId,
  propertyId: saleProperty.propertyId,
  slotId: multiCapacitySlot.slotId,
  listingType: "sale",
  customerName: "Demo Buyer",
  customerEmail: "demo.buyer@example.com",
  status: "confirmed",
  startsAt: multiCapacitySlot.startsAt,
  reportDelivery: {
    reportJobId: "24000000-0000-4000-8000-000000000001",
    reportStatus: "queued",
    deliveryId: "25000000-0000-4000-8000-000000000001",
    deliveryStatus: "waiting_report",
  },
});

export const saleDeliveryStates = Object.freeze([
  "waiting_report",
  "email_queued",
  "fallback_queued",
  "sending",
  "sent",
  "retry",
  "failed",
]);
