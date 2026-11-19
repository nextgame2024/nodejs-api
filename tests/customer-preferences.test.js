import { test, expect } from "@jest/globals";
import {
  requestedLanguage,
  bookingName,
  bookingEmail,
} from "../src/services/messaging/customer-preferences.js";
test("explicit language changes survive numeric booking replies without guessing from topic", () => {
  for (const text of [
    "Quiero hablar en español",
    "Can we speak Spanish?",
    "español",
  ])
    expect(requestedLanguage(text)).toBe("es");
  expect(requestedLanguage("Please continue in English")).toBe("en");
  expect(requestedLanguage("Prefiro falar português")).toBe("pt");
  for (const text of [
    "2",
    "CONFIRM 123456",
    "What services do you offer?",
    "Do you offer Spanish translation?",
    "not in Spanish",
  ])
    expect(requestedLanguage(text)).toBeNull();
});
test("booking name is explicit, bounded and supports international names", () => {
  expect(bookingName("NOMBRE José Muñoz")).toBe("José Muñoz");
  expect(bookingName("NAME Anne-Marie O’Neill")).toBe("Anne-Marie O’Neill");
  for (const text of [
    "2",
    "CONFIRM 123456",
    "I want to cancel",
    "NAME <script>",
    "NAME " + "a".repeat(161),
  ])
    expect(bookingName(text)).toBeNull();
});

test("booking email accepts addresses and rejects malformed or oversized input", () => {
  expect(bookingEmail("jose+booking@example.com")).toBe(
    "jose+booking@example.com",
  );
  expect(bookingEmail("Correo: jose@example.com")).toBe("jose@example.com");
  for (const text of [
    "not-an-email",
    "a@b",
    "a b@example.com",
    "<a@example.com>",
    "a".repeat(321) + "@example.com",
  ])
    expect(bookingEmail(text)).toBeNull();
});

test("contact replies accept name/email in either order without swallowing unrelated questions", () => {
  for (const text of [
    "José Muñoz, jose@example.com",
    "jose@example.com\nJosé Muñoz",
    "My name is José Muñoz and my email is jose@example.com",
    "Nombre: José Muñoz\nCorreo: jose@example.com",
  ]) {
    expect(bookingName(text)).toBe("José Muñoz");
    expect(bookingEmail(text)).toBe("jose@example.com");
  }
  for (const text of [
    "What is the price? jose@example.com",
    "I need help jose@example.com",
    "Please book a meeting jose@example.com",
  ]) {
    expect(bookingName(text)).toBeNull();
    expect(bookingEmail(text)).toBeNull();
  }
});
